// Self-signed TLS for LAN play. Browsers only grant cross-origin isolation
// (SharedArrayBuffer, required by the threaded mGBA core) in secure contexts:
// https:// anywhere, or http:// on localhost. Players joining over the LAN
// therefore need HTTPS — a self-signed cert with a one-time browser warning
// is the tradeoff that keeps the server self-contained.
//
// The cert MUST satisfy Apple's rules or iOS Safari/Chrome silently refuse it
// (symptom: endless spinner on the phone while desktop works fine):
//   - validity <= 398 days (Apple hard limit for certs issued after 2020-09)
//   - an ExtendedKeyUsage extension with id-kp-serverAuth
//   - a SubjectAltName matching the address (IP SAN for IP-based URLs)
//   - SHA-256, RSA >= 2048
// See: "Requirements for trusted certificates in iOS 13 / macOS 10.15".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bump to force everyone to regenerate (e.g. when these requirements change).
const CERT_SCHEMA = 2;

/** localhost + every current non-internal IPv4, sorted (stable for compare). */
function currentSans() {
  const ips = ['127.0.0.1'];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return [...new Set(ips)].sort();
}

/**
 * Load the persisted cert pair, or generate an iOS-compatible one. Regenerates
 * automatically when the schema bumps or the machine's LAN IPs change (so a
 * new DHCP address is always covered by the cert's SAN).
 * @param {string} dir directory to persist the cert material
 * @returns {Promise<{key: string|Buffer, cert: string|Buffer}>}
 */
export async function ensureCert(dir) {
  const keyFile = path.join(dir, 'tls-key.pem');
  const certFile = path.join(dir, 'tls-cert.pem');
  const metaFile = path.join(dir, 'tls-meta.json');
  const sans = currentSans();

  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (meta.schema === CERT_SCHEMA && JSON.stringify(meta.sans) === JSON.stringify(sans)) {
        return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
      }
    } catch { /* corrupt meta: regenerate */ }
  }

  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    ...sans.map((ip) => ({ type: 7, ip })), // IP
  ];

  const { generate } = await import('selfsigned');
  const pems = await generate([{ name: 'commonName', value: 'MultiBoyAdvance' }], {
    days: 398, // Apple's hard ceiling; comfortably under it
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true }, // iOS requires serverAuth
      { name: 'subjectAltName', altNames },
    ],
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(metaFile, JSON.stringify({ schema: CERT_SCHEMA, sans }));
  console.log(`[mba] generated iOS-compatible TLS cert for: ${sans.join(', ')}`);
  return { key: pems.private, cert: pems.cert };
}
