// One-shot dynamic-DNS update (npm run dns) — same config as the server's
// built-in updater; handy for testing the token before starting the server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDnsConfig, updateDnsOnce } from './dns-updater.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadDnsConfig(path.resolve(here, '../data'));
if (!cfg) {
  console.error('not configured: create server/data/dns.json with {"token": "...", "domain": "mouftools.com", "name": "mba"}');
  process.exit(1);
}
const { ip, action, teamId } = await updateDnsOnce(cfg);
console.log(`${cfg.name}.${cfg.domain} -> ${ip} (${action})`);
if (teamId && !cfg.teamId) {
  console.log(`hint: domain found in team scope ${teamId} — add "teamId": "${teamId}" to dns.json to skip auto-discovery`);
}
