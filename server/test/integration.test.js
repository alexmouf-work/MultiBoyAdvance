// Full-transport integration: real HTTP+WS+TCP servers on ephemeral ports,
// one WebSocket bridge and one raw-TCP bridge talking to the same world.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createServers } from '../src/index.js';

function testCfg() {
  return {
    httpPort: 0,
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
