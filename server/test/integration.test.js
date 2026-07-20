// Full-transport integration: real HTTP+WS+TCP servers on ephemeral ports,
// one WebSocket bridge and one raw-TCP bridge talking to the same world.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createServers } from '../src/index.js';

function testCfg() {
  return {
    httpPort: 0,
    httpsPort: 0,
    tlsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mba-tls-')),
    tcpPort: 0,
    host: '127.0.0.1',
    // fileURLToPath, not URL.pathname: pathname yields "/C:/..." on Windows
    webRoot: fileURLToPath(new URL('../../web', import.meta.url)),
    dataFile: null,
    maxPlayers: 8,
    protocolVersion: 1,
    battleJoinWindowMs: 50,
    clientTimeoutMs: 60_000,
    syncedFlagRanges: [[0x020, 0x97f]],
    syncedVarRanges: [[0x4000, 0x40ff]],
  };
}

function wsBridge(port) {
  const inbox = [];
  const waiters = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (const w of [...waiters]) w();
  });
  return {
    inbox,
    send: (obj) => ws.send(JSON.stringify(obj)),
    open: new Promise((r) => ws.on('open', r)),
    close: () => ws.close(),
    async waitFor(t, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = inbox.find((m) => m.t === t);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}; got ${inbox.map((m) => m.t)}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 25);
        });
      }
    },
  };
}

function tcpBridge(port) {
  const inbox = [];
  const sock = net.connect(port, '127.0.0.1');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) inbox.push(JSON.parse(line));
    }
  });
  return {
    inbox,
    send: (obj) => sock.write(JSON.stringify(obj) + '\n'),
    open: new Promise((r) => sock.on('connect', r)),
    close: () => sock.destroy(),
    async waitFor(t, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = inbox.find((m) => m.t === t);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${t}; got ${inbox.map((m) => m.t)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
}

test('WS and TCP bridges share one world: presence + flags cross transports', async () => {
  const srv = createServers(testCfg());
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => srv.tcpServer.listen(0, '127.0.0.1', r));
  const wsPort = srv.httpServer.address().port;
  const tcpPort = srv.tcpServer.address().port;

  const browser = wsBridge(wsPort);
  const lua = tcpBridge(tcpPort);
  await browser.open;
  await lua.open;

  browser.send({ t: 'hello', name: 'Browser', proto: 1 });
  const w1 = await browser.waitFor('welcome');
  lua.send({ t: 'hello', name: 'DesktopMGBA', proto: 1 });
  const w2 = await lua.waitFor('welcome');
  assert.notEqual(w1.slot, w2.slot);

  // Same map: each sees the other's ghost, across different transports.
  browser.send({ t: 'pos', g: 0, n: 9, x: 8, y: 3, f: 1, s: 0 });
  lua.send({ t: 'pos', g: 0, n: 9, x: 9, y: 3, f: 3, s: 0 });
  const ghostAtBrowser = await browser.waitFor('ghost');
  const ghostAtLua = await lua.waitFor('ghost');
  assert.equal(ghostAtBrowser.slot, w2.slot);
  assert.equal(ghostAtLua.slot, w1.slot);

  // Story flag set from the TCP side reaches the WS side.
  lua.send({ t: 'flag', id: 0x2a0 });
  assert.equal((await browser.waitFor('flag')).id, 0x2a0);

  // ping/pong liveness
  browser.send({ t: 'ping' });
  await browser.waitFor('pong');

  browser.close();
  lua.close();
  srv.close();
});

test('http host serves the web client with cross-origin isolation headers', async () => {
  const srv = createServers(testCfg());
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
  const body = await res.text();
  assert.match(body, /MultiBoyAdvance/);

  const evil = await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`);
  assert.ok([403, 404].includes(evil.status), `traversal must not serve (got ${evil.status})`);

  srv.close();
});

test('static assets carry an ETag and revalidate to 304 (no re-download each load)', async () => {
  const srv = createServers(testCfg());
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;

  // First load: full 200 with a strong validator.
  const first = await fetch(`http://127.0.0.1:${port}/index.html`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'static responses must carry an ETag so the browser can revalidate');
  await first.text();

  // Reload with the ETag the browser now holds: unchanged file → 304, no body.
  const revalidated = await fetch(`http://127.0.0.1:${port}/index.html`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(revalidated.status, 304, 'unchanged asset must 304, not re-send the bytes');
  assert.equal((await revalidated.text()).length, 0, '304 must not carry a body');

  srv.close();
});

test('/api/users lists the trainer registry for the join screen', async () => {
  const srv = createServers(testCfg());
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;

  const empty = await (await fetch(`http://127.0.0.1:${port}/api/users`)).json();
  assert.deepEqual(empty.users, []);

  const zoe = srv.world.addClient({ name: 'Zoe' }, () => {});
  srv.world.handle(zoe, { t: 'pos', g: 0, n: 18, x: 3, y: 3, f: 0, s: 0 });
  const online = await (await fetch(`http://127.0.0.1:${port}/api/users`)).json();
  assert.equal(online.users[0].name, 'Zoe');
  assert.equal(online.users[0].online, true);
  assert.deepEqual([online.users[0].g, online.users[0].n], [0, 18]);

  srv.world.removeClient(zoe);
  const offline = await (await fetch(`http://127.0.0.1:${port}/api/users`)).json();
  assert.equal(offline.users[0].online, false);
  assert.ok(offline.users[0].lastSeenAt <= Date.now());
  srv.close();
});

test('lanUrls ranks real LAN IPs above virtual adapters', async () => {
  const { lanUrls } = await import('../src/index.js');
  const lines = lanUrls(8443);
  // On any host with a network, the block is emitted with the guidance footer.
  if (lines.length) {
    assert.match(lines[0], /LAN players/);
    assert.match(lines.at(-1), /192\.168/);
    // any 172.x line must be flagged as a probable virtual adapter
    for (const l of lines) {
      if (/https:\/\/172\./.test(l)) assert.match(l, /virtual adapter/);
    }
  }
});

test('PWA manifest + icons serve so the app is installable', async () => {
  const srv = createServers(testCfg());
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;

  const mani = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
  assert.equal(mani.status, 200);
  assert.match(mani.headers.get('content-type'), /manifest\+json/);
  const body = await mani.json();
  assert.equal(body.display, 'standalone');
  assert.ok(body.icons.some((i) => i.purpose === 'maskable'), 'has a maskable icon');

  for (const icon of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
    const res = await fetch(`http://127.0.0.1:${port}/icons/${icon}`);
    assert.equal(res.status, 200, icon);
    assert.match(res.headers.get('content-type'), /image\/png/);
  }
  const head = await (await fetch(`http://127.0.0.1:${port}/index.html`)).text();
  assert.match(head, /rel="manifest"/);
  assert.match(head, /apple-touch-icon/);
  srv.close();
});

test('robots.txt and sitemap.xml serve for search-engine indexing', async () => {
  const srv = createServers(testCfg());
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;

  const robots = await fetch(`http://127.0.0.1:${port}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('content-type'), /text\/plain/);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /Sitemap: https:\/\/mba\.mouftools\.com\/sitemap\.xml/);
  assert.match(robotsBody, /Disallow: \/rom\//); // the ROM binary stays out of the crawl
  assert.match(robotsBody, /Disallow: \/api\//);

  const sitemap = await fetch(`http://127.0.0.1:${port}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type'), /xml/);
  assert.match(await sitemap.text(), /<loc>https:\/\/mba\.mouftools\.com\/<\/loc>/);

  const home = await (await fetch(`http://127.0.0.1:${port}/index.html`)).text();
  assert.match(home, /name="description"/);
  assert.match(home, /rel="canonical" href="https:\/\/mba\.mouftools\.com\/"/);
  srv.close();
});

test('/api/rom-info fingerprints the served build', async () => {
  const cfg = testCfg();
  const romDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mba-rominfo-'));
  cfg.romFile = path.join(romDir, 'mba.gba');
  fs.writeFileSync(cfg.romFile, Buffer.from([1, 2, 3, 4]));

  const srv = createServers(cfg);
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;

  const info = await (await fetch(`http://127.0.0.1:${port}/api/rom-info`)).json();
  assert.equal(info.size, 4);
  // sha256 of 01 02 03 04
  assert.equal(info.sha256, '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a');

  fs.rmSync(cfg.romFile);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/rom-info`)).status, 404);
  srv.close();
});

test('/api/save round-trips per-trainer game saves', async () => {
  const cfg = testCfg();
  cfg.savesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mba-saves-'));
  const srv = createServers(cfg);
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;
  const url = (n) => `http://127.0.0.1:${port}/api/save/${encodeURIComponent(n)}`;

  // no save yet
  assert.equal((await fetch(url('Alex'))).status, 404);

  // upload, then read back — keyed case-insensitively like the registry
  const save = Uint8Array.from([1, 2, 3, 4, 5]);
  const put = await fetch(url('Alex'), { method: 'PUT', body: save });
  assert.equal(put.status, 204);
  const got = await fetch(url('ALEX'));
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), save);

  // the key is sanitized to filename-safe characters — traversal is inert
  const evil = await fetch(url('../../etc/passwd'), { method: 'PUT', body: save });
  assert.equal(evil.status, 204);
  assert.deepEqual(fs.readdirSync(cfg.savesDir).sort(), ['alex.sav', 'etcpasswd.sav']);

  // empty and oversized bodies are refused
  assert.equal((await fetch(url('Alex'), { method: 'PUT', body: new Uint8Array(0) })).status, 400);
  assert.equal(
    (await fetch(url('Alex'), { method: 'PUT', body: new Uint8Array(300 * 1024) })).status,
    413,
  );
  srv.close();
});

test('/rom/mba.gba serves the host build fresh, 404s when absent', async () => {
  const cfg = testCfg();
  const romDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mba-rom-'));
  cfg.romFile = path.join(romDir, 'mba.gba');
  fs.writeFileSync(cfg.romFile, Buffer.from([0xde, 0xad, 0xbe, 0xef]));

  const srv = createServers(cfg);
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  const port = srv.httpServer.address().port;

  const head = await fetch(`http://127.0.0.1:${port}/rom/mba.gba`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  const res = await fetch(`http://127.0.0.1:${port}/rom/mba.gba`);
  // Cacheable-but-revalidated: the browser keeps the ROM and revalidates by ETag
  // so unchanged builds cost a 304, not a full re-download, every load.
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const etag = res.headers.get('etag');
  assert.ok(etag, 'the ROM carries an ETag for conditional requests');
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));

  // A conditional request with the current ETag revalidates as 304 (no body).
  const notMod = await fetch(`http://127.0.0.1:${port}/rom/mba.gba`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(notMod.status, 304);
  assert.equal((await notMod.arrayBuffer()).byteLength, 0);

  // "update the build on demand": a rebuild changes the hash, so the same
  // conditional request now misses (new ETag) and the fresh bytes are served.
  fs.writeFileSync(cfg.romFile, Buffer.from([0x01]));
  const res2 = await fetch(`http://127.0.0.1:${port}/rom/mba.gba`, {
    headers: { 'if-none-match': etag },
  });
  assert.equal(res2.status, 200);
  assert.notEqual(res2.headers.get('etag'), etag, 'a rebuild yields a new ETag');
  assert.equal((await res2.arrayBuffer()).byteLength, 1);

  fs.rmSync(cfg.romFile);
  const gone = await fetch(`http://127.0.0.1:${port}/rom/mba.gba`);
  assert.equal(gone.status, 404);
  srv.close();
});

test('https server (self-signed) serves the client with isolation headers', async () => {
  const srv = createServers(testCfg());
  await srv.listen(); // generates the cert into tlsDir, starts all listeners
  await new Promise((r) => setTimeout(r, 50)); // let listeners settle
  assert.ok(srv.httpsServer, 'https server started');
  const port = srv.httpsServer.address().port;

  const res = await new Promise((resolve, reject) => {
    https
      .get({ host: '127.0.0.1', port, path: '/index.html', rejectUnauthorized: false }, resolve)
      .on('error', reject);
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(res.headers['cross-origin-embedder-policy'], 'require-corp');
  res.resume();

  srv.close();
});
