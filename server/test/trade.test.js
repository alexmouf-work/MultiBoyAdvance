// Player-to-player trading (docs/plans/TRADING.md): offer / accept / counter /
// reject, validation at accept, and the exact admin/deliver message sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.js';

function makeCfg(overrides = {}) {
  return {
    maxPlayers: 8,
    battleJoinWindowMs: 25,
    clientTimeoutMs: 60_000,
    syncedFlagRanges: [[0x020, 0x97f]],
    syncedVarRanges: [[0x4000, 0x40ff]],
    dataFile: null,
    ...overrides,
  };
}

function join(world, name) {
  const inbox = [];
  const client = world.addClient({ name }, (obj) => inbox.push(obj));
  return { client, inbox };
}

const msgs = (inbox, t) => inbox.filter((m) => m.t === t);

/** Wire mon with just the species bytes set (all validation reads b[8..9]). */
function wireMon(sp, lv = 10) {
  const b = new Array(32).fill(0);
  b[8] = sp & 0xff;
  b[9] = sp >> 8;
  b[20] = lv;
  return { lv, b };
}

/** Report a party of species ids for a client (summary + full, like a bridge). */
function setParty(world, client, species) {
  world.handle(client, { t: 'party', mons: species.map((sp) => ({ sp, lv: 10, hp: 100 })) });
  world.handle(client, { t: 'party.full', mons: species.map((sp) => wireMon(sp)) });
}

test('trade.offer stores a pending offer and notifies the target', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  setParty(world, a.client, [252, 261]);

  world.handle(a.client, {
    t: 'trade.offer',
    to: 1,
    give: { mons: [{ slot: 0, sp: 252 }], items: [{ id: 13, qty: 2 }] },
    want: { mons: [{ sp: 263 }] },
  });

  const req = msgs(b.inbox, 'trade.req')[0];
  assert.ok(req, 'target got trade.req');
  assert.equal(req.from, 0);
  assert.equal(req.name, 'Ann');
  assert.deepEqual(req.give.mons, [{ slot: 0, sp: 252 }]);
  assert.deepEqual(req.give.items, [{ id: 13, qty: 2 }]);
  assert.deepEqual(req.want.mons, [{ sp: 263 }]);
  assert.ok(b.client.tradeOffers.has(0), 'pending offer stored on the target');
  world.close();
});

test('offer guards: offline target, self-trade, empty terms, giving whole party', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  setParty(world, a.client, [252]);

  world.handle(a.client, { t: 'trade.offer', to: 5, give: {}, want: { items: [{ id: 1, qty: 1 }] } });
  assert.match(msgs(a.inbox, 'error').at(-1).msg, /not available/);

  world.handle(a.client, { t: 'trade.offer', to: 0, give: {}, want: { items: [{ id: 1, qty: 1 }] } });
  assert.match(msgs(a.inbox, 'error').at(-1).msg, /not available/);

  const b = join(world, 'Ben');
  world.handle(a.client, { t: 'trade.offer', to: 1, give: {}, want: {} });
  assert.match(msgs(a.inbox, 'error').at(-1).msg, /empty trade/);

  // Ann has one mon; offering it would leave an empty party — refused.
  world.handle(a.client, { t: 'trade.offer', to: 1, give: { mons: [{ slot: 0, sp: 252 }] }, want: {} });
  assert.match(msgs(a.inbox, 'error').at(-1).msg, /cannot offer/);
  assert.equal(msgs(b.inbox, 'trade.req').length, 0);
  world.close();
});

test('reject clears the offer and tells the proposer', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  setParty(world, a.client, [252, 261]);

  world.handle(a.client, { t: 'trade.offer', to: 1, give: { mons: [{ slot: 0, sp: 252 }] }, want: {} });
  world.handle(b.client, { t: 'trade.reject', from: 0 });

  assert.equal(b.client.tradeOffers.size, 0);
  const cancel = msgs(a.inbox, 'trade.cancelled')[0];
  assert.equal(cancel.from, 1);
  assert.equal(cancel.reason, 'rejected');

  // A second reject is a no-op (no duplicate notifications).
  world.handle(b.client, { t: 'trade.reject', from: 0 });
  assert.equal(msgs(a.inbox, 'trade.cancelled').length, 1);
  world.close();
});

test('accept executes both legs: takes before gives, mons in descending slot order', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  setParty(world, a.client, [252, 261, 263]); // gives slots 0 and 2
  setParty(world, b.client, [283, 285]); // request resolves 285 -> slot 1

  world.handle(a.client, {
    t: 'trade.offer',
    to: 1,
    give: { mons: [{ slot: 0, sp: 252 }, { slot: 2, sp: 263 }], items: [{ id: 13, qty: 3 }] },
    want: { mons: [{ sp: 285 }], items: [{ id: 4, qty: 1 }] },
  });
  a.inbox.length = 0;
  b.inbox.length = 0;
  world.handle(b.client, { t: 'trade.accept', from: 0 });

  // Ann's leg out: take_mon slot 2 BEFORE slot 0 (descending), then take_item.
  const annAdmin = msgs(a.inbox, 'admin');
  assert.deepEqual(
    annAdmin.map((m) => [m.sub, m.slot ?? m.item]),
    [['take_mon', 2], ['take_mon', 0], ['take_item', 13], ['give_item', 4]],
  );
  // Ben receives Ann's two mons (263 first — same order as the takes).
  const benMons = msgs(b.inbox, 'trade.deliver');
  assert.deepEqual(benMons.map((m) => m.b[8] | (m.b[9] << 8)), [263, 252]);
  // Ben's admin stream: leg 1 hands him the give_item first, then his own leg
  // takes his 285 (slot 1) and his item 4.
  const benAdmin = msgs(b.inbox, 'admin');
  assert.deepEqual(
    benAdmin.map((m) => [m.sub, m.slot ?? m.item]),
    [['give_item', 13], ['take_mon', 1], ['take_item', 4]],
  );
  const annMons = msgs(a.inbox, 'trade.deliver');
  assert.deepEqual(annMons.map((m) => m.b[8] | (m.b[9] << 8)), [285]);

  for (const side of [a, b]) {
    const done = msgs(side.inbox, 'trade.done')[0];
    assert.equal(done.ok, true);
    assert.match(done.summary, /#252/);
    assert.match(done.summary, /#285/);
  }
  world.close();
});

test('accept fails cleanly when parties changed or the offer expired', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  setParty(world, a.client, [252, 261]);
  setParty(world, b.client, [283, 285]);

  // Proposer's party changed between offer and accept -> both told, no legs run.
  world.handle(a.client, { t: 'trade.offer', to: 1, give: { mons: [{ slot: 0, sp: 252 }] }, want: {} });
  setParty(world, a.client, [261, 252]); // reshuffled: slot 0 is no longer 252
  a.inbox.length = 0;
  b.inbox.length = 0;
  world.handle(b.client, { t: 'trade.accept', from: 0 });
  assert.equal(msgs(b.inbox, 'trade.done')[0].ok, false);
  assert.equal(msgs(a.inbox, 'trade.done')[0].ok, false);
  assert.equal(msgs(a.inbox, 'admin').length, 0, 'no leg executed');

  // Acceptor no longer has the requested species -> fail.
  world.handle(a.client, { t: 'trade.offer', to: 1, give: {}, want: { mons: [{ sp: 300 }] } });
  b.inbox.length = 0;
  world.handle(b.client, { t: 'trade.accept', from: 0 });
  assert.equal(msgs(b.inbox, 'trade.done')[0].ok, false);

  // Expired offer -> fail (fake the timestamp).
  world.handle(a.client, { t: 'trade.offer', to: 1, give: {}, want: { mons: [{ sp: 283 }] } });
  b.client.tradeOffers.get(0).at = Date.now() - 121_000;
  b.inbox.length = 0;
  world.handle(b.client, { t: 'trade.accept', from: 0 });
  assert.match(msgs(b.inbox, 'trade.done')[0].msg, /expired/);
  world.close();
});

test('disconnect cancels pending offers both ways', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  const c = join(world, 'Cyn');
  setParty(world, a.client, [252, 261]);
  setParty(world, c.client, [283, 285]);

  world.handle(a.client, { t: 'trade.offer', to: 1, give: { mons: [{ slot: 0, sp: 252 }] }, want: {} }); // Ann -> Ben
  world.handle(c.client, { t: 'trade.offer', to: 1, give: { mons: [{ slot: 0, sp: 283 }] }, want: {} }); // Cyn -> Ben
  world.handle(a.client, { t: 'trade.offer', to: 2, give: { mons: [{ slot: 1, sp: 261 }] }, want: {} }); // Ann -> Cyn

  world.removeClient(b.client); // Ben leaves with two received offers pending
  assert.equal(msgs(a.inbox, 'trade.cancelled').at(-1).reason, 'offline');
  assert.equal(msgs(c.inbox, 'trade.cancelled').at(-1).reason, 'offline');
  // Ann -> Cyn offer survives (Cyn is still here)…
  assert.ok(c.client.tradeOffers.has(0));
  // …but dies when Ann leaves, silently consumed on Cyn's side.
  world.removeClient(a.client);
  assert.equal(c.client.tradeOffers.size, 0);
  world.close();
});

test('/trade console command: one-mon offer and accept round-trip', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  setParty(world, a.client, [252, 261]);
  setParty(world, b.client, [283, 285]);

  world.handle(a.client, { t: 'cmd', line: '/trade Ben give 1 for 283' });
  assert.match(msgs(a.inbox, 'cmd.result').at(-1).msg, /offer sent/);
  const req = msgs(b.inbox, 'trade.req')[0];
  assert.deepEqual(req.give.mons, [{ slot: 0, sp: 252 }]);
  assert.deepEqual(req.want.mons, [{ sp: 283 }]);

  world.handle(b.client, { t: 'cmd', line: '/trade Ann accept' });
  assert.equal(msgs(b.inbox, 'trade.done')[0].ok, true);
  assert.equal(msgs(a.inbox, 'trade.done')[0].ok, true);
  world.close();
});
