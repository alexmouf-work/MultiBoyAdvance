// Self-signed TLS for LAN play. Browsers only grant cross-origin isolation
// (SharedArrayBuffer, required by the threaded mGBA core) in secure contexts:
// https:// anywhere, or http:// on localhost. Players joining over the LAN
// therefore need HTTPS — a self-signed cert with a one-time browser warning
// is the tradeoff that keeps the server self-contained.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Load the persisted cert pair, or generate one (valid ~10 years) with SANs
 * for localhost and every current LAN IPv4.
 * @param {string} dir directory to persist tls-key.pem / tls-cert.pem
 * @returns {Promise<{key: string|Buffer, cert: string|Buffer}>}
 */
export async function ensureCert(dir) {
  const keyFile = path.join(dir, 'tls-key.pem');
  const certFile = path.join(dir, 'tls-cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  const altNames = [
    { type: 2, value: 'localhost' }, // DNS
    { type: 7, ip: '127.0.0.1' },    // IP
  ];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) altNames.push({ type: 7, ip: iface.address });
    }
  }

  const { generate } = await import('selfsigned');
  const pems = await generate([{ name: 'commonName', value: 'MultiBoyAdvance' }], {
    days: 3650,
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}
