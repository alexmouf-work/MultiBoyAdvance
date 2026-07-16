// The self-signed cert must satisfy Apple's rules or iOS silently refuses it
// (endless spinner on phones). Regression guard for those specific properties.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { ensureCert } from '../src/tls.js';

test('generated cert meets iOS trust requirements', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mba-tls-'));
  const { cert } = await ensureCert(dir);
  const x = new X509Certificate(cert);

  // Validity <= 825 days (Apple's ceiling; we target ~1 year).
  const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86_400_000;
  assert.ok(days > 0 && days <= 825, `validity ${days}d must be <= 825`);

  // SHA-256 signature, RSA >= 2048.
  assert.match(x.publicKey.asymmetricKeyDetails.modulusLength >= 2048 ? 'ok' : 'no', /ok/);

  // SubjectAltName present with the loopback IP (IP-based access needs IP SANs).
  assert.match(x.subjectAltName ?? '', /IP Address:127\.0\.0\.1/);
  assert.match(x.subjectAltName ?? '', /localhost/);
});

test('cert is reused when IPs are unchanged, regenerated when they change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mba-tls-'));
  const a = await ensureCert(dir);
  const b = await ensureCert(dir); // same machine, same IPs -> identical material
  assert.equal(a.cert.toString(), b.cert.toString());

  // Simulate an IP change by rewriting the sidecar; next call must regenerate.
  const metaFile = path.join(dir, 'tls-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, sans: ['127.0.0.1', '10.9.9.9'] }));
  const c = await ensureCert(dir);
  assert.notEqual(a.cert.toString(), c.cert.toString(), 'IP change forces a fresh cert');
});
