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
  // The login screen must actually hide (it has display:flex, which overrides
  // the [hidden] UA rule unless we restore it). offsetParent === null means it
  // is genuinely display:none, not merely covered by the game.
  await page.waitForFunction(() => document.querySelector('#login')?.offsetParent === null,
    null, { timeout: 5000 });
  await page.waitForSelector('#chip-server.ok', { timeout: 5000 });
  await page.waitForFunction(() => window.mba?.ui?.slot !== null, null, { timeout: 5000 });
  return page;
}

const evts = (page) => page.evaluate(() => window.mba.adapter.events);

// Join demo mode inside a phone-like touch context (portrait), so the mobile
// immersive layout (fixed full-screen frame + pop-out OPTIONS panel) is active.
async function joinAsMobile(name) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  await page.goto(`${baseUrl}/?demo=1`);
  await page.fill('#name', name);
  await page.click('#btn-demo');
  await page.waitForFunction(() => document.querySelector('#login')?.offsetParent === null,
    null, { timeout: 8000 });
  await page.waitForFunction(() => window.mba?.ui?.slot !== null, null, { timeout: 8000 });
  page._ctx = ctx;
  return page;
}

// Is the speed button actually the top element at its own center (i.e. tappable,
// not buried behind the game frame)? Returns false when it has no box either.
const speedReachable = (page) => page.evaluate(() => {
  const b = document.querySelector('#btn-speed');
  const r = b?.getBoundingClientRect();
  if (!r || !r.width) return false;
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return top === b || b.contains(top);
});
const speedMenuOpen = (page) =>
  page.evaluate(() => document.querySelector('#speed-menu')?.hidden === false);
const tapById = (page, id) => page.evaluate((i) => document.getElementById(i).click(), id);

test('mobile: speed control stays reachable + its menu never strands open', async () => {
  const page = await joinAsMobile('Mia');

  // Overlay is the default mobile mode: an immersive frame where the prefs live
  // in the pop-out OPTIONS panel, so the speed button is hidden until it opens.
  assert.equal(await page.evaluate(() => document.querySelector('#gamewrap').className),
    'mobile-overlay');
  assert.equal(await speedReachable(page), false, 'speed hidden while OPTIONS is closed');

  await tapById(page, 'btn-options');
  assert.equal(await speedReachable(page), true, 'speed reachable once OPTIONS opens');
  await tapById(page, 'btn-speed');
  assert.equal(await speedMenuOpen(page), true, 'first tap opens the speed menu');

  // The regression: close the panel while the menu is open, then reopen. The
  // menu must come back collapsed — otherwise the next ⚡ tap toggles the wrong
  // way and the button reads as dead (the "logout then cancel" symptom).
  await tapById(page, 'btn-options'); // close
  await tapById(page, 'btn-options'); // reopen
  assert.equal(await speedMenuOpen(page), false, 'menu is reset (collapsed) on reopen');
  await tapById(page, 'btn-speed');
  assert.equal(await speedMenuOpen(page), true, 'one tap re-opens it — toggle not inverted');

  // Below mode is also full-screen on a phone, so its prefs + logout have to be
  // reachable through the same OPTIONS panel (they used to be stranded behind
  // the fixed game frame with no gear to reach them).
  await tapById(page, 'btn-pad-mode'); // overlay -> below
  assert.equal(await page.evaluate(() => document.querySelector('#gamewrap').className),
    'controls-below');
  assert.equal(await page.evaluate(() => document.querySelector('#btn-options')?.offsetParent !== null),
    true, 'the OPTIONS gear is available in below mode');
  assert.equal(await speedReachable(page), true, 'speed reachable in below mode too');
  assert.equal(await page.evaluate(() =>
    Boolean(document.querySelector('#options-panel #btn-logout'))), true,
    'logout is reachable via the panel in below mode');

  await page._ctx.close();
});

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

  // --- shared story flag (dev-harness call; the UI buttons were removed) ---
  await ann.evaluate(() => window.mba.adapter.setStoryFlag(0x2a1));
  await ben.waitForFunction(
    () => window.mba.adapter.events.some((e) => e.t === 'flag.applied' && e.id === 0x2a1),
    null,
    { timeout: 5000 },
  );
  // the world remembers: server-side state now carries the flag
  assert.equal(srv.world.state.flags.has(0x2a1), true);

  // --- co-op battle: open -> offer -> join -> shared seed & order ---
  await ann.evaluate(() => window.mba.adapter.startEncounter());
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

  // --- teleport via roster button: "/tpa" style — Ann must accept first ---
  await ben.click(`#players li[data-slot="${annSlot}"] button[data-action="tp"]`);
  await ann.waitForSelector('.offer button[data-action="tp-accept"]', { timeout: 5000 });
  await ann.click('.offer button[data-action="tp-accept"]');
  await ben.waitForFunction(
    (pos) => {
      const me = window.mba.adapter.me;
      return me.x === pos.x && me.y === pos.y;
    },
    { x: 7, y: 6 },
    { timeout: 5000 },
  );

  // --- ghost proximity: Ben now stands on Ann's tile, so the interaction
  // chip (battle / give item) must surface ---
  await ben.waitForSelector('#proximity:not([hidden])', { timeout: 5000 });

  // --- console: a command typed by Ben lands in his game as an admin TLV ---
  await ben.fill('#console-in', '/give me item 13 3');
  await ben.press('#console-in', 'Enter');
  await ben.waitForFunction(
    () => window.mba.adapter.events.some(
      (e) => e.t === 'admin' && e.sub === 'give_item' && e.item === 13 && e.qty === 3),
    null,
    { timeout: 5000 },
  );

  // --- join screen roster: the server remembers both trainers, shows their
  // status + location, and playing trainers are not clickable ---
  const roster = await browser.newPage();
  await roster.goto(baseUrl);
  await roster.waitForSelector('.user-chip', { timeout: 5000 });
  const chips = await roster.$$eval('.user-chip', (els) => els.map((el) => ({
    name: el.querySelector('.uname').textContent,
    loc: el.querySelector('.uloc').textContent,
    disabled: el.disabled,
  })));
  for (const who of ['Ann', 'Ben']) {
    const chip = chips.find((c) => c.name === who);
    assert.ok(chip, `${who} appears in the join-screen roster`);
    assert.equal(chip.disabled, true, 'online trainers are not clickable');
    assert.match(chip.loc, /playing now · Littleroot Town/); // demo map is (0,9)
  }
  await roster.close();

  // --- /resetlocal: wipes this browser's local data and reloads to login ---
  await ben.evaluate(() => localStorage.setItem('mba.padScale', '150'));
  await ben.fill('#console-in', '/resetlocal');
  await ben.press('#console-in', 'Enter');
  await ben.waitForSelector('#login:not([hidden])', { timeout: 10_000 });
  assert.equal(await ben.evaluate(() => localStorage.length), 0, 'localStorage wiped');

  // --- logout button returns to the start screen ---
  ann.on('dialog', (d) => d.accept());
  await ann.click('#btn-logout');
  await ann.waitForSelector('#login:not([hidden])', { timeout: 10_000 });

  await ann.close();
  await ben.close();
});
