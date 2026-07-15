// The Phase-0 acceptance test (docs/ROADMAP.md): two real browsers in demo
// mode against a live server must see each other move, share story flags,
// run the co-op battle join flow with one shared seed, and teleport.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServers } from '../../server/src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let srv;
let baseUrl;
let browser;

before(async () => {
  srv = createServers({
    httpPort: 0,
    tcpPort: 0,
    host: '127.0.0.1',
    webRoot: path.resolve(here, '../../web'),
    dataFile: null,
    maxPlayers: 8,
    protocolVersion: 1,
    battleJoinWindowMs: 1500,
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

async function joinAsDemo(name) {
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/?demo=1`); // demo is a dev-only harness now
  await page.fill('#name', name);
  await page.click('#btn-demo');
  await page.waitForSelector('#chip-server.ok', { timeout: 5000 });
  await page.waitForFunction(() => window.mba?.ui?.slot !== null, null, { timeout: 5000 });
  return page;
}

const evts = (page) => page.evaluate(() => window.mba.adapter.events);

test('two browsers share one world end-to-end', async () => {
  const ann = await joinAsDemo('Ann');
  const ben = await joinAsDemo('Ben');

  const annSlot = await ann.evaluate(() => window.mba.ui.slot);
  const benSlot = await ben.evaluate(() => window.mba.ui.slot);
  assert.notEqual(annSlot, benSlot);

  // --- presence: Ann moves, Ben's game renders her ghost at the same tile ---
  await ann.click('#screen');
  await ann.keyboard.press('ArrowRight');
  await ann.keyboard.press('ArrowRight');
  await ann.keyboard.press('ArrowDown');

  await ben.waitForFunction(
    (slot) => {
      const g = window.mba.adapter.ghosts.get(slot);
      return g && g.x === 7 && g.y === 6;
    },
    annSlot,
    { timeout: 5000 },
  );
  // and vice versa: Ben appears in Ann's world at his spawn tile
  await ben.click('#screen');
  await ben.keyboard.press('ArrowLeft');
  await ann.waitForFunction(
    (slot) => window.mba.adapter.ghosts.has(slot),
    benSlot,
    { timeout: 5000 },
  );

  // --- shared story flag ---
  await ann.click('#btn-flag');
  await ben.waitForFunction(
    () => window.mba.adapter.events.some((e) => e.t === 'flag.applied' && e.id === 0x2a1),
    null,
    { timeout: 5000 },
  );
  // the world remembers: server-side state now carries the flag
  assert.equal(srv.world.state.flags.has(0x2a1), true);

  // --- co-op battle: open -> offer -> join -> shared seed & order ---
  await ann.click('#btn-battle');
  await ben.waitForSelector('.offer button[data-action="join-battle"]', { timeout: 5000 });
  await ben.click('.offer button[data-action="join-battle"]');

  await ann.waitForFunction(
    () => window.mba.adapter.events.some((e) => e.t === 'battle.started'),
    null,
    { timeout: 8000 },
  );
  await ben.waitForFunction(
    () => window.mba.adapter.events.some((e) => e.t === 'battle.started'),
    null,
    { timeout: 8000 },
  );
  const annStart = (await evts(ann)).find((e) => e.t === 'battle.started');
  const benStart = (await evts(ben)).find((e) => e.t === 'battle.started');
  assert.equal(annStart.seed, benStart.seed, 'both simulate from one seed');
  assert.deepEqual(annStart.order, benStart.order);
  assert.deepEqual([...annStart.order].sort(), [annSlot, benSlot].sort());

  // The merged full party (top ceil(6/2)=3 wire mons from each of the two
  // 3-mon demo parties) must have reached both games via BATTLE_CMD PARTY.
  for (const page of [ann, ben]) {
    const staged = await page.evaluate(() =>
      window.mba.adapter.events.find((e) => e.t === 'battle.party')?.count ?? 0);
    assert.equal(staged, 6, 'merged party staged in the game before START');
  }

  // initiator wins; joiner regroups at the battle site via warp
  await ann.click('#btn-end-battle');
  await ben.waitForFunction(
    () => window.mba.adapter.events.some((e) => e.t === 'battle.ended' && e.result === 1),
    null,
    { timeout: 5000 },
  );
  await ben.waitForFunction(
    () => window.mba.adapter.events.some((e) => e.t === 'warped'),
    null,
    { timeout: 5000 },
  );

  // --- teleport via roster button ---
  await ben.click(`#players li[data-slot="${annSlot}"] button[data-action="tp"]`);
  await ben.waitForFunction(
    (pos) => {
      const me = window.mba.adapter.me;
      return me.x === pos.x && me.y === pos.y;
    },
    { x: 7, y: 6 },
    { timeout: 5000 },
  );

  await ann.close();
  await ben.close();
});
