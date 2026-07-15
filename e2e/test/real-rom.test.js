// Real-ROM smoke test: boot the built netcode ROM (rom/build/mba.gba) in the
// actual mGBA-WASM core inside Chromium, and verify the game↔bridge↔server
// pipeline comes alive: mailbox discovered in EWRAM, HELLO received
// (status "game-ready"), frame counter advancing, server session joined.
//
// Skips (cleanly) when the ROM hasn't been built — CI doesn't build it.
// Overworld interactions (ghosts in the real game) need a save file that has
// cleared the intro; that's the Phase-1 LAN test on real machines.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServers } from '../../server/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROM = path.resolve(here, '../../rom/build/mba.gba');
const romExists = fs.existsSync(ROM);

let srv;
let baseUrl;
let browser;

before(async () => {
  if (!romExists) return;
  srv = createServers({
    httpPort: 0,
    tcpPort: 0,
    host: '127.0.0.1',
    webRoot: path.resolve(here, '../../web'),
    dataFile: null,
    romFile: ROM, // the packaged-ROM join flow serves this
    maxPlayers: 8,
    protocolVersion: 1,
    battleJoinWindowMs: 3000,
    clientTimeoutMs: 60_000,
    syncedFlagRanges: [[0x020, 0x97f]],
    syncedVarRanges: [[0x4000, 0x40ff]],
  });
  await new Promise((r) => srv.httpServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => srv.tcpServer.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${srv.httpServer.address().port}`;
  browser = await chromium.launch().catch(() =>
    chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }),
  );
});

after(async () => {
  await browser?.close();
  srv?.close();
});

test('netcode ROM boots in mGBA-WASM and attaches to the world', { skip: !romExists && 'rom/build/mba.gba not built' }, async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(baseUrl);

  // The threaded core demands cross-origin isolation; fail loudly if hosting broke.
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);

  await page.fill('#name', 'RealRom');
  // The packaged-ROM flow: the join button enables once /rom/mba.gba is
  // found on the server, and clicking it fetches + boots the build.
  await page.waitForSelector('#btn-join:not([disabled])', { timeout: 10_000 });
  await page.click('#btn-join');

  // Emulator up + ROM loaded (adapter logs "loaded mba.gba" to the event log).
  await page.waitForSelector('#log li[data-t="rom"]', { timeout: 30_000 });

  // The bridge must find the mailbox that NetTick() planted in EWRAM and then
  // see the game's HELLO ("game-ready").
  await page.waitForFunction(
    () => document.querySelector('#chip-mailbox')?.textContent.includes('attached') ||
          document.querySelector('#chip-mailbox')?.textContent.includes('game-ready'),
    null, { timeout: 30_000 },
  );
  await page.waitForFunction(
    () => window.mba.bridge.status === 'game-ready',
    null, { timeout: 30_000 },
  );

  // Liveness: the game-side frame counter must advance between samples.
  const fc = () => page.evaluate(() => {
    const { adapter } = window.mba;
    const { findMailbox, Mailbox } = window.mbaMailbox;
    const mem = adapter.memory();
    const base = findMailbox(mem);
    return base >= 0 ? new Mailbox(mem, base).frameCounter : -1;
  });
  const a = await fc();
  await new Promise((r) => setTimeout(r, 500));
  const b = await fc();
  assert.ok(a >= 0 && b >= 0, 'mailbox reachable from test');
  assert.notEqual(a, b, `frameCounter advances (${a} -> ${b})`);

  // And the server saw a real session join.
  await page.waitForFunction(() => window.mba.ui.slot !== null, null, { timeout: 10_000 });
  assert.equal(srv.world.clients.size, 1);

  assert.deepEqual(errors, [], 'no uncaught page errors');
  await page.close();
});
