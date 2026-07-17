// Unit tests for the JS mailbox codec (web/js/bridge/mailbox.js) — the layout
// half of the game/bridge contract. Runs in Node (the module is DOM-free).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Mailbox, findMailbox, MAILBOX_MAGIC, MAILBOX_SIZE, PROTO_VERSION, RING_SIZE, T, enc, dec,
} from '../js/bridge/mailbox.js';

function plantMailbox(memSize = 4096, base = 512) {
  const mem = new Uint8Array(memSize);
  mem.set(MAILBOX_MAGIC, base);
  mem[base + 4] = PROTO_VERSION;
  return { mem, box: new Mailbox(mem, base), base };
}

test('scanner finds a 4-aligned mailbox and rejects wrong version', () => {
  const { mem, base } = plantMailbox();
  assert.equal(findMailbox(mem), base);

  // decoy with wrong version earlier in memory is skipped
  mem.set(MAILBOX_MAGIC, 128);
  mem[128 + 4] = 99;
  assert.equal(findMailbox(mem), base);

  // unaligned magic is skipped
  const mem2 = new Uint8Array(4096);
  mem2.set(MAILBOX_MAGIC, 130); // not 4-aligned
  mem2[130 + 4] = PROTO_VERSION;
  assert.equal(findMailbox(mem2), -1);
});

test('rings: write/read round-trip, order preserved, capacity respected', () => {
  const { box } = plantMailbox();

  // host->game ring: writeIn / (game-side) _readRing(532)
  assert.equal(box.writeIn(T.FLAG_APPLY, enc.flagApply(0x2a1)), true);
  assert.equal(box.writeIn(T.WARP, enc.warp(3, 7, -5, 40)), true);
  const got = box._readRing(532);
  assert.equal(got.length, 2);
  assert.equal(got[0].type, T.FLAG_APPLY);
  assert.deepEqual(dec.flag(got[0].payload), { id: 0x2a1 });
  assert.deepEqual(dec.warp(got[1].payload), { g: 3, n: 7, x: -5, y: 40 });

  // fill until full: capacity is RING_SIZE-1 bytes, records are 2+len
  let wrote = 0;
  while (box.writeIn(T.GHOST, enc.ghost(1, 1, 0, 9, 8, 3, 1, 0))) wrote++;
  assert.equal(wrote, Math.floor((RING_SIZE - 1) / (2 + 10)));
  // drain frees space again
  box._readRing(532);
  assert.equal(box.writeIn(T.GHOST, enc.ghost(1, 1, 0, 9, 8, 3, 1, 0)), true);
});

test('rings wrap across the buffer boundary without corruption', () => {
  const { box } = plantMailbox();
  const payload = enc.presence(1, 2, 300, -300, 4, 0); // 8 bytes
  // Cycle enough records through that head/tail wrap several times.
  for (let i = 0; i < 300; i++) {
    assert.equal(box._writeRing(16, T.PRESENCE, payload), true);
    const [rec] = box._readRing(16);
    assert.equal(rec.type, T.PRESENCE);
    assert.deepEqual(dec.presence(rec.payload), { g: 1, n: 2, x: 300, y: -300, f: 4, s: 0 });
  }
});

test('battle codecs: start/input round-trip including seed edge values', () => {
  for (const seed of [0, 1, 0x7fffffff, 0xdeadbeef, 0xffffffff]) {
    const p = enc.battleStart(seed, [2, 0], 'coop');
    const d = dec.battleCmd(p);
    assert.equal(d.sub, 'start');
    assert.equal(d.seed, seed >>> 0);
    assert.deepEqual(d.order, [2, 0]);
    assert.equal(d.mode, 'coop');
  }
  const pvp = dec.battleCmd(enc.battleStart(42, [1, 3], 'pvp'));
  assert.equal(pvp.mode, 'pvp');

  const input = dec.battleCmd(enc.battleTurnRelay(7, 3, 1, 2, 0, 0x1234));
  assert.deepEqual(input, { sub: 'input', turn: 7, from: 3, a: 1, move: 2, tgt: 0, x: 0x1234 });
});

test('party summary and presence codecs round-trip', () => {
  const mons = [
    { sp: 252, lv: 34, hp: 100 },
    { sp: 384, lv: 70, hp: 1 },
  ];
  assert.deepEqual(dec.partySummary(enc.partySummary(mons)), mons);

  const p = dec.presence(enc.presence(24, 3, -1, 1023, 2, 1));
  assert.deepEqual(p, { g: 24, n: 3, x: -1, y: 1023, f: 2, s: 1 });
});

test('header fields: frame counter, slot, hostAttached, validity', () => {
  const { mem, box, base } = plantMailbox();
  assert.equal(box.valid, true);
  box.setPlayerSlot(5);
  box.setHostAttached(1);
  assert.equal(mem[base + 8], 5);
  assert.equal(mem[base + 9], 1);
  mem[base + 6] = 0x34;
  mem[base + 7] = 0x12;
  assert.equal(box.frameCounter, 0x1234);
  mem[base] = 0; // clobber magic -> invalid (reset detection)
  assert.equal(box.valid, false);
});

test('struct size constant matches the C layout', () => {
  assert.equal(MAILBOX_SIZE, 16 + 2 * (4 + RING_SIZE));
});

test('full-party wire codec: round-trip and BATTLE_CMD PARTY framing', () => {
  const monA = new Array(32).fill(0).map((_, i) => i); // 0..31
  const monB = new Array(32).fill(7);
  monA[20] = 42; // level byte
  monB[20] = 9;

  const decoded = dec.partyFull(enc.partyFull([monA, monB]));
  assert.equal(decoded.length, 2);
  assert.deepEqual(decoded[0].b, monA);
  assert.equal(decoded[0].lv, 42);
  assert.equal(decoded[1].lv, 9);

  // host->game framing: sub=4, count, then blobs — fits one TLV (len ≤ 255)
  const framed = enc.battleParty([monA, monB, monA, monB, monA, monB]);
  assert.equal(framed[0], 4);
  assert.equal(framed[1], 6);
  assert.equal(framed.length, 2 + 6 * 32);
  assert.ok(framed.length <= 255);
});

test('admin codec: every sub round-trips through enc/dec', () => {
  const cases = [
    { sub: 'give_item', item: 13, qty: 3 },
    { sub: 'take_item', item: 0xffff, qty: 999 },
    { sub: 'give_mon', species: 252, level: 5 },
    { sub: 'set_level', slot: 2, level: 100 },
    { sub: 'give_xp', slot: 0, xp: 1_000_000 },
    { sub: 'wild_battle', species: 384, level: 70 },
    { sub: 'reset_trainer', trainer: 0x35f },
    { sub: 'set_name', name: [0xbb, 0xd6, 0x00, 0xaa, 0xee, 0xff, 0xff, 0xff] },
    { sub: 'take_mon', slot: 5, sp: 283 },
  ];
  for (const m of cases) {
    assert.deepEqual(dec.admin(enc.admin(m)), m, m.sub);
  }
  assert.equal(enc.admin({ sub: 'bogus' }), null);
  assert.equal(dec.admin(Uint8Array.from([99])).sub, 'unknown');
});

test('team battle codecs: extended encounter, START with enemy, turn.begin', () => {
  const enemy = new Array(32).fill(0);
  enemy[8] = 286 & 0xff;
  enemy[9] = 286 >> 8;
  enemy[20] = 9;

  // Encounter: legacy 4-byte form has no enemy; extended form carries it.
  assert.equal(dec.battleEvent(enc.battleEncounter(0, 286)).enemy, null);
  const ext = dec.battleEvent(enc.battleEncounter(0, 286, enemy));
  assert.equal(ext.sub, 'encounter');
  assert.equal(ext.opp, 286);
  assert.deepEqual(ext.enemy, enemy);

  // START: coop/pvp stay 11 bytes; team appends init + enemy wires.
  assert.equal(enc.battleStart(1234, [0, 1], 'coop').length, 11);
  const teamStart = enc.battleStart(0xdeadbeef, [0, 1], 'team', 1, [enemy]);
  assert.equal(teamStart.length, 13 + 32);
  const d = dec.battleCmd(teamStart);
  assert.equal(d.mode, 'team');
  assert.equal(d.seed, 0xdeadbeef);
  assert.deepEqual(d.order, [0, 1]);
  assert.equal(d.init, 1);
  assert.deepEqual(d.enemy, [enemy]);

  // TURN_BEGIN round-trip.
  const tb = dec.battleEvent(enc.battleTurnBegin(3, 2));
  assert.deepEqual(tb, { sub: 'turn.begin', turn: 3, controller: 2 });
});

test('trade.deliver codec: 32 wire bytes through, species/level picked out', () => {
  const b = new Array(32).fill(0);
  b[8] = 283 & 0xff; // Mudkip (internal Hoenn order)
  b[9] = 283 >> 8;
  b[20] = 17;
  const payload = enc.tradeDeliver(b);
  assert.equal(payload.length, 32);
  const d = dec.tradeDeliver(payload);
  assert.deepEqual(d.b, b);
  assert.equal(d.sp, 283);
  assert.equal(d.lv, 17);
  // short/overlong inputs are clamped to the wire size
  assert.equal(enc.tradeDeliver([...b, 99, 99]).length, 32);
});
