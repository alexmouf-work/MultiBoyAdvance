// MultiBoyAdvance server entry point.
//  - HTTP  :8484: serves web/ with cross-origin isolation (mgba-wasm is
//                 threaded). Secure-context note: browsers only honor the
//                 isolation over https or on localhost, so...
//  - HTTPS :8443: same app with a self-signed cert — the URL LAN players use
//  - WS   /ws on both: browser bridges
//  - TCP   :8485: desktop mGBA Lua bridges (newline-delimited JSON, same schema)

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { ensureCert } from './tls.js';
import { loadDnsConfig, startDnsUpdater } from './dns-updater.js';
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
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export function createServers(cfg = config) {
  const world = new World(cfg);

  // ---- static host (shared by the HTTP and HTTPS servers) ----
  const webRoot = path.resolve(cfg.webRoot);
  const romInfoCache = { key: null, body: null };
  const requestHandler = (req, res) => {
    const url = new URL(req.url, 'http://x');

    // ROM build fingerprint — lets the client verify its download matches
    // what the host built (stale-build / corrupted-transfer diagnostics).
    if (url.pathname === '/api/rom-info') {
      fs.stat(cfg.romFile ?? '', (err, st) => {
        if (err) return res.writeHead(404).end();
        const cacheKey = `${st.mtimeMs}:${st.size}`;
        if (romInfoCache.key !== cacheKey) {
          const hash = crypto.createHash('sha256').update(fs.readFileSync(cfg.romFile)).digest('hex');
          romInfoCache.key = cacheKey;
          romInfoCache.body = JSON.stringify({ size: st.size, sha256: hash, builtAt: st.mtimeMs });
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(romInfoCache.body);
      });
      return;
    }

    // Trainer roster for the join screen: every known player, online status,
    // and last/current location. Read-only; docs/PROTOCOL.md §2.4.
    if (url.pathname === '/api/users') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ users: world.usersSnapshot() }));
      return;
    }

    // Per-trainer game saves (docs/PROTOCOL.md §2.4): bridges PUT the .sav
    // after every in-game save; joins GET it back before booting the ROM.
    if (url.pathname.startsWith('/api/save/')) {
      // Same key rule as the trainer registry, restricted to filename-safe
      // characters — the key IS the filename, so nothing else may pass.
      const key = decodeURIComponent(url.pathname.slice('/api/save/'.length))
        .toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim();
      if (!key || !cfg.savesDir) {
        res.writeHead(key ? 501 : 400).end();
        return;
      }
      const file = path.join(cfg.savesDir, `${key}.sav`);
      if (req.method === 'GET' || req.method === 'HEAD') {
        fs.readFile(file, (err, data) => {
          if (err) return res.writeHead(404).end();
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': data.length,
            'cache-control': 'no-store',
          });
          res.end(req.method === 'HEAD' ? undefined : data);
        });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
          size += c.length;
          if (size > 256 * 1024) {
            res.writeHead(413).end();
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          if (res.writableEnded) return;
          const body = Buffer.concat(chunks);
          if (!body.length) return res.writeHead(400).end();
          fs.mkdirSync(cfg.savesDir, { recursive: true });
          const tmp = `${file}.tmp`;
          fs.writeFileSync(tmp, body);
          fs.renameSync(tmp, file); // atomic: a crashed upload never corrupts
          const u = world.state.users.get(key);
          if (u) {
            u.savedAt = Date.now();
            world.state._scheduleSave();
          }
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(405).end();
      return;
    }

    // The host's current ROM build — always the latest, straight from disk.
    if (url.pathname === '/rom/mba.gba') {
      fs.readFile(cfg.romFile ?? '', (err, data) => {
        if (err) {
          res.writeHead(404).end('no ROM build on the server (run the ROM build first)');
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': data.length,
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
          'cache-control': 'no-store', // a rebuild must be picked up immediately
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
      return;
    }

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
  };
  const httpServer = http.createServer(requestHandler);
  let httpsServer = null;

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

  // ---- WebSocket transport (attached to both HTTP and HTTPS) ----
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    const conn = attach(send, () => ws.close());
    ws.on('message', (raw) => conn.onMessage(raw.toString()));
    ws.on('close', () => conn.onClose());
    ws.on('error', () => {});
  });
  const handleUpgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  httpServer.on('upgrade', handleUpgrade);

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

  const api = {
    world,
    httpServer,
    tcpServer,
    httpsServer: null,
    async listen() {
      httpServer.listen(cfg.httpPort, cfg.host, () => {
        console.log(`[mba] http      on http://${cfg.host}:${cfg.httpPort}  (serving ${cfg.webRoot})`);
      });
      tcpServer.listen(cfg.tcpPort, cfg.host, () => {
        console.log(`[mba] tcp bridge on ${cfg.host}:${cfg.tcpPort}`);
      });
      // HTTPS: LAN browsers only grant the cross-origin isolation the mGBA
      // core needs in a secure context — https (any host) or plain http on
      // localhost. Self-signed: players accept a one-time warning.
      try {
        const { key, cert } = await ensureCert(cfg.tlsDir);
        httpsServer = https.createServer({ key, cert }, requestHandler);
        httpsServer.on('upgrade', handleUpgrade);
        api.httpsServer = httpsServer;
        httpsServer.listen(cfg.httpsPort, cfg.host, () => {
          console.log(`[mba] https     on https://${cfg.host}:${cfg.httpsPort}  <- LAN players use this one`);
        });
      } catch (err) {
        console.warn(`[mba] https disabled (${err.message}); LAN ROM play will not work, localhost still will`);
      }
      // Opt-in dynamic DNS: keeps <name>.<domain> pointed at this network's
      // public IP via the Vercel API (config: data/dns.json or env).
      const dnsCfg = loadDnsConfig(path.dirname(cfg.dataFile ?? cfg.tlsDir));
      if (dnsCfg) this.stopDns = startDnsUpdater(dnsCfg);
      else console.log('[mba] dynamic dns: off (no data/dns.json or MBA_VERCEL_TOKEN)');
    },
    close() {
      clearInterval(reaper);
      this.stopDns?.();
      wss.close();
      httpServer.close();
      httpsServer?.close();
      tcpServer.close();
      world.close();
    },
  };
  return api;
}

// fileURLToPath, not URL.pathname: pathname yields "/C:/..." on Windows and
// the comparison would never match, so `npm start` would silently exit.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServers().listen().catch((err) => {
    console.error('[mba] failed to start:', err);
    process.exit(1);
  });
}
