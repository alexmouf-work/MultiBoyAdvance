// MultiBoyAdvance server entry point.
//  - HTTP: serves web/ with cross-origin isolation (mgba-wasm is threaded)
//  - WS  /ws: browser bridges
//  - TCP :8485: desktop mGBA Lua bridges (newline-delimited JSON, same schema)

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { World } from './world/world.js';
import { parseMessage } from './protocol.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export function createServers(cfg = config) {
  const world = new World(cfg);

  // ---- HTTP static host ----
  const webRoot = path.resolve(cfg.webRoot);
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(path.join(webRoot, rel));
    if (file !== webRoot && !file.startsWith(webRoot + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        // Cross-origin isolation: required by the threaded mGBA WASM core.
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cache-control': 'no-cache',
      });
      res.end(data);
    });
  });

  // ---- shared per-connection glue ----
  function attach(send, closeTransport) {
    let client = null;
    return {
      onMessage(raw) {
        const parsed = parseMessage(raw);
        if (!parsed.ok) {
          send({ t: 'error', msg: parsed.error });
          return;
        }
        if (!client) {
          if (parsed.msg.t !== 'hello') {
            send({ t: 'error', msg: 'hello first' });
            return;
          }
          client = world.addClient(parsed.msg, send);
          if (!client) closeTransport();
          return;
        }
        world.handle(client, parsed.msg);
      },
      onClose() {
        if (client) world.removeClient(client);
      },
    };
  }

  // ---- WebSocket transport ----
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss.on('connection', (ws) => {
    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    const conn = attach(send, () => ws.close());
    ws.on('message', (raw) => conn.onMessage(raw.toString()));
    ws.on('close', () => conn.onClose());
    ws.on('error', () => {});
  });

  // ---- raw TCP transport (JSON lines) ----
  const tcpServer = net.createServer((sock) => {
    sock.setNoDelay(true);
    const send = (obj) => {
      if (!sock.destroyed) sock.write(JSON.stringify(obj) + '\n');
    };
    const conn = attach(send, () => sock.destroy());
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) conn.onMessage(line);
        if (buf.length > 65536) {
          sock.destroy();
          return;
        }
      }
    });
    sock.on('close', () => conn.onClose());
    sock.on('error', () => {});
  });

  const reaper = setInterval(() => world.reapStale(), 10_000);
  reaper.unref();

  return {
    world,
    httpServer,
    tcpServer,
    listen() {
      httpServer.listen(cfg.httpPort, cfg.host, () => {
        console.log(`[mba] web+ws    on http://${cfg.host}:${cfg.httpPort}  (serving ${cfg.webRoot})`);
      });
      tcpServer.listen(cfg.tcpPort, cfg.host, () => {
        console.log(`[mba] tcp bridge on ${cfg.host}:${cfg.tcpPort}`);
      });
    },
    close() {
      clearInterval(reaper);
      wss.close();
      httpServer.close();
      tcpServer.close();
      world.close();
    },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  createServers().listen();
}
