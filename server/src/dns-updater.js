// Dynamic-DNS updater for Vercel-managed domains. Home IPs change; this keeps
// the A record (e.g. mba.mouftools.com) pointed at the current public IP.
// Zero dependencies — Vercel's REST API + any public what's-my-ip endpoint.
//
// Config (either env vars or server/data/dns.json — gitignored):
//   { "token": "<vercel API token>", "domain": "mouftools.com",
//     "name": "mba", "intervalMinutes": 5 }

import fs from 'node:fs';
import path from 'node:path';

const IP_PROVIDERS = [
  'https://api.ipify.org',
  'https://checkip.amazonaws.com',
  'https://ifconfig.me/ip',
];

const API = 'https://api.vercel.com';

/** Current public IPv4, trying providers in order. */
export async function getPublicIp(fetchImpl = fetch) {
  let lastErr = new Error('no ip providers');
  for (const url of IP_PROVIDERS) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const ip = (await res.text()).trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`${url}: not an IPv4 ("${ip}")`);
      return ip;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Ensure the A record `cfg.name`.`cfg.domain` points at the current public IP.
 * Creates the record when missing; replaces it when the IP changed.
 * @returns {Promise<{ip: string, action: 'none'|'created'|'updated'}>}
 */
export async function updateDnsOnce(cfg, fetchImpl = fetch) {
  const ip = await getPublicIp(fetchImpl);
  const auth = { authorization: `Bearer ${cfg.token}` };

  const listRes = await fetchImpl(`${API}/v4/domains/${cfg.domain}/records?limit=100`, { headers: auth });
  if (!listRes.ok) throw new Error(`Vercel list records: HTTP ${listRes.status} ${await listRes.text()}`);
  const listBody = await listRes.json();
  const records = listBody.records ?? listBody;
  const existing = records.filter((r) => r.type === 'A' && r.name === cfg.name);

  if (existing.length === 1 && existing[0].value === ip) return { ip, action: 'none' };

  for (const r of existing) {
    const del = await fetchImpl(`${API}/v2/domains/${cfg.domain}/records/${r.id}`, {
      method: 'DELETE',
      headers: auth,
    });
    if (!del.ok) throw new Error(`Vercel delete record ${r.id}: HTTP ${del.status}`);
  }

  const create = await fetchImpl(`${API}/v2/domains/${cfg.domain}/records`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: cfg.name, type: 'A', value: ip, ttl: 60 }),
  });
  if (!create.ok) throw new Error(`Vercel create record: HTTP ${create.status} ${await create.text()}`);

  return { ip, action: existing.length ? 'updated' : 'created' };
}

/** Read config from env (MBA_VERCEL_TOKEN, MBA_DNS_DOMAIN, MBA_DNS_NAME) or
 *  <dataDir>/dns.json. Returns null when not configured — the feature is opt-in. */
export function loadDnsConfig(dataDir) {
  const env = process.env;
  if (env.MBA_VERCEL_TOKEN && env.MBA_DNS_DOMAIN) {
    return {
      token: env.MBA_VERCEL_TOKEN,
      domain: env.MBA_DNS_DOMAIN,
      name: env.MBA_DNS_NAME ?? 'mba',
      intervalMinutes: Number(env.MBA_DNS_INTERVAL ?? 5),
    };
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'dns.json'), 'utf8'));
    if (cfg.token && cfg.domain) {
      return { name: 'mba', intervalMinutes: 5, ...cfg };
    }
  } catch {
    // absent or malformed: feature stays off
  }
  return null;
}

/** Run once now, then on an interval. Returns a stop function. */
export function startDnsUpdater(cfg, log = console) {
  let lastGood = null;
  const run = async () => {
    try {
      const { ip, action } = await updateDnsOnce(cfg);
      if (action !== 'none' || lastGood !== ip) {
        log.log(`[mba] dns: ${cfg.name}.${cfg.domain} -> ${ip} (${action})`);
      }
      lastGood = ip;
    } catch (err) {
      log.warn(`[mba] dns update failed: ${err.message}`);
    }
  };
  run();
  const timer = setInterval(run, Math.max(1, cfg.intervalMinutes) * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
