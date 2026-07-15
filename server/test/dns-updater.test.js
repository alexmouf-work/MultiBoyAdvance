// Unit tests for the Vercel dynamic-DNS updater — network fully mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicIp, updateDnsOnce } from '../src/dns-updater.js';

const ok = (body, json = false) => ({
  ok: true,
  status: 200,
  text: async () => (json ? JSON.stringify(body) : body),
  json: async () => body,
});
const fail = (status = 500) => ({ ok: false, status, text: async () => 'nope' });

test('getPublicIp falls back across providers and validates the answer', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (calls.length === 1) return fail();          // provider 1 down
    if (calls.length === 2) return ok('<html>');    // provider 2 talks nonsense
    return ok(' 203.0.113.7\n');                    // provider 3 good
  };
  assert.equal(await getPublicIp(fetchImpl), '203.0.113.7');
  assert.equal(calls.length, 3);

  await assert.rejects(() => getPublicIp(async () => fail()), /HTTP 500/);
});

function vercelMock({ records, requireTeam = null }) {
  const log = [];
  const fetchImpl = async (url, opts = {}) => {
    log.push({ url, method: opts.method ?? 'GET' });
    if (url.includes('ipify')) return ok('198.51.100.9');
    if (url.includes('/v2/teams')) return ok({ teams: [{ id: 'team_abc' }, { id: requireTeam ?? 'team_xyz' }] });
    if (url.includes('/v4/domains/') && url.includes('records')) {
      // Domain lives in a team scope: personal-scope calls are forbidden.
      if (requireTeam && !url.includes(`teamId=${requireTeam}`)) {
        return { ok: false, status: 403, text: async () => '{"error":{"code":"forbidden"}}', json: async () => ({}) };
      }
      return ok({ records });
    }
    if ((opts.method ?? 'GET') === 'DELETE') return ok({});
    if (opts.method === 'POST') {
      log.at(-1).body = JSON.parse(opts.body);
      return ok({ uid: 'new' });
    }
    return fail(404);
  };
  return { fetchImpl, log };
}

const cfg = { token: 't', domain: 'mouftools.com', name: 'mba' };

test('creates the record when missing', async () => {
  const { fetchImpl, log } = vercelMock({ records: [{ id: 'x', type: 'A', name: 'www', value: '1.2.3.4' }] });
  const res = await updateDnsOnce(cfg, fetchImpl);
  assert.deepEqual(res, { ip: '198.51.100.9', action: 'created', teamId: null });
  const post = log.find((l) => l.method === 'POST');
  assert.deepEqual(post.body, { name: 'mba', type: 'A', value: '198.51.100.9', ttl: 60 });
  assert.ok(!log.some((l) => l.method === 'DELETE'));
});

test('no-op when the record already points at the current IP', async () => {
  const { fetchImpl, log } = vercelMock({ records: [{ id: 'r1', type: 'A', name: 'mba', value: '198.51.100.9' }] });
  const res = await updateDnsOnce(cfg, fetchImpl);
  assert.deepEqual(res, { ip: '198.51.100.9', action: 'none', teamId: null });
  assert.ok(!log.some((l) => l.method === 'POST' || l.method === 'DELETE'));
});

test('replaces a stale record (delete then create)', async () => {
  const { fetchImpl, log } = vercelMock({ records: [{ id: 'r1', type: 'A', name: 'mba', value: '203.0.113.1' }] });
  const res = await updateDnsOnce(cfg, fetchImpl);
  assert.deepEqual(res, { ip: '198.51.100.9', action: 'updated', teamId: null });
  assert.ok(log.some((l) => l.method === 'DELETE' && l.url.includes('/records/r1')));
  assert.ok(log.some((l) => l.method === 'POST'));
});

test('403 in personal scope: discovers the owning team and retries with teamId', async () => {
  const { fetchImpl, log } = vercelMock({ records: [], requireTeam: 'team_home' });
  const res = await updateDnsOnce(cfg, fetchImpl);
  assert.deepEqual(res, { ip: '198.51.100.9', action: 'created', teamId: 'team_home' });
  // subsequent mutations carry the discovered teamId
  const post = log.find((l) => l.method === 'POST');
  assert.ok(post.url.includes('teamId=team_home'), post.url);
});

test('explicit teamId in config is used directly (no discovery)', async () => {
  const { fetchImpl, log } = vercelMock({ records: [], requireTeam: 'team_home' });
  const res = await updateDnsOnce({ ...cfg, teamId: 'team_home' }, fetchImpl);
  assert.equal(res.action, 'created');
  assert.ok(!log.some((l) => l.url.includes('/v2/teams')), 'no team discovery call');
});
