import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Join a fake player; returns {client, inbox}. */
function join(world, name) {
  const inbox = [];
  const client = world.addClient({ name }, (obj) => inbox.push(obj));
  return { client, inbox };
}

const msgs = (inbox, t) => inbox.filter((m) => m.t === t);

test('welcome carries roster and world state; join/leave broadcast', () => {
  const world = new World(makeCfg());
  world.state.setFlag(0x300);

  const a = join(world, 'Alex');
  assert.equal(msgs(a.inbox, 'welcome')[0].slot, 0);
  assert.deepEqual(msgs(a.inbox, 'welcome')[0].flags, [0x300]);

  const b = join(world, 'Sam');
  assert.equal(msgs(b.inbox, 'welcome')[0].slot, 1);
  const roster = msgs(b.inbox, 'welcome')[0].players;
  assert.deepEqual(roster.map((p) => ({ slot: p.slot, name: p.name })), [{ slot: 0, name: 'Alex' }]);
  assert.ok(roster[0].onlineMs >= 0, 'welcome carries online duration');
  assert.equal(msgs(a.inbox, 'join')[0].name, 'Sam');

  world.removeClient(b.client);
  assert.equal(msgs(a.inbox, 'leave')[0].slot, 1);
  world.close();
});

test('ghosts route only within the same map, despawn on map change', () => {
  const world = new World(makeCfg());
  const a = join(world, 'A');
  const b = join(world, 'B');
  const c = join(world, 'C');

  world.handle(a.client, { t: 'pos', g: 1, n: 4, x: 10, y: 5, f: 2, s: 0 });
  world.handle(b.client, { t: 'pos', g: 1, n: 4, x: 12, y: 5, f: 1, s: 0 });
  world.handle(c.client, { t: 'pos', g: 9, n: 9, x: 0, y: 0, f: 0, s: 0 });

  // b entering a's map introduced both to each other
  assert.equal(msgs(a.inbox, 'ghost').at(-1).slot, 1);
  assert.equal(msgs(b.inbox, 'ghost').at(-1).slot, 0);
  assert.equal(msgs(c.inbox, 'ghost').length, 0); // different map hears nothing

  // movement on same map fans out
  world.handle(b.client, { t: 'pos', g: 1, n: 4, x: 13, y: 5, f: 3, s: 1 });
  assert.equal(msgs(a.inbox, 'ghost').at(-1).x, 13);

  // map change: a hears despawn (s=255)
  world.handle(b.client, { t: 'pos', g: 2, n: 0, x: 1, y: 1, f: 0, s: 0 });
  assert.equal(msgs(a.inbox, 'ghost').at(-1).s, 255);
  world.close();
});

test('flags: filtered by range, recorded once, broadcast to all', () => {
  const world = new World(makeCfg());
  const a = join(world, 'A');
  const b = join(world, 'B');

  world.handle(a.client, { t: 'flag', id: 0x005 }); // below synced range
  assert.equal(world.state.flags.has(0x005), false);

  world.handle(a.client, { t: 'flag', id: 0x321 });
  assert.equal(msgs(b.inbox, 'flag')[0].id, 0x321);
  assert.equal(msgs(a.inbox, 'flag')[0].id, 0x321); // echoed to setter too

  world.handle(b.client, { t: 'flag', id: 0x321 }); // duplicate: no re-broadcast
  assert.equal(msgs(a.inbox, 'flag').length, 1);
  world.close();
});

test('battle: offer to same map, join, merged start with shared seed, input relay, end warp', async () => {
  const world = new World(makeCfg({ battleJoinWindowMs: 20 }));
  const a = join(world, 'A');
  const b = join(world, 'B');
  world.handle(a.client, { t: 'pos', g: 1, n: 1, x: 5, y: 5, f: 0, s: 0 });
  world.handle(b.client, { t: 'pos', g: 1, n: 1, x: 6, y: 5, f: 0, s: 0 });
  world.handle(a.client, { t: 'party', mons: [{ sp: 1, lv: 50 }, { sp: 2, lv: 40 }, { sp: 3, lv: 30 }, { sp: 4, lv: 20 }] });
  world.handle(b.client, { t: 'party', mons: [{ sp: 9, lv: 45 }, { sp: 10, lv: 35 }] });

  world.handle(a.client, { t: 'battle.open', kind: 1, opp: 261 });
  const offer = msgs(b.inbox, 'battle.offer')[0];
  assert.ok(offer, 'peer on the same map gets the offer');
  world.handle(b.client, { t: 'battle.join', sid: offer.sid });

  await sleep(40); // join window elapses -> battle.start
  const startA = msgs(a.inbox, 'battle.start')[0];
  const startB = msgs(b.inbox, 'battle.start')[0];
  assert.ok(startA && startB);
  assert.equal(startA.seed, startB.seed);
  assert.deepEqual(startA.order, [0, 1]);
  // ceil(6/2)=3 from each, but B only has 2 mons -> 5 total
  assert.equal(startA.party.length, 5);
  assert.equal(startA.party[0].sp, 1); // lv50 leads

  world.handle(a.client, { t: 'battle.input', sid: offer.sid, turn: 1, a: 1, move: 2 });
  assert.equal(msgs(b.inbox, 'battle.input')[0].move, 2);
  assert.equal(msgs(a.inbox, 'battle.input').length, 0); // not echoed to sender

  world.handle(a.client, { t: 'battle.end', sid: offer.sid, result: 1 });
  const endB = msgs(b.inbox, 'battle.end')[0];
  assert.equal(endB.result, 1);
  assert.equal(msgs(b.inbox, 'warp')[0].g, 1); // winner regroup at battle site
  world.close();
});

test('battle: solo initiator dissolves silently after window', async () => {
  const world = new World(makeCfg({ battleJoinWindowMs: 15 }));
  const a = join(world, 'A');
  world.handle(a.client, { t: 'pos', g: 1, n: 1, x: 5, y: 5, f: 0, s: 0 });
  world.handle(a.client, { t: 'battle.open', kind: 1, opp: 300 });
  await sleep(35);
  assert.equal(msgs(a.inbox, 'battle.start').length, 0);
  world.close();
});

test('teleport resolves to target position; pvp handshake starts immediately', () => {
  const world = new World(makeCfg());
  const a = join(world, 'A');
  const b = join(world, 'B');
  world.handle(b.client, { t: 'pos', g: 3, n: 7, x: 21, y: 9, f: 0, s: 0 });

  world.handle(a.client, { t: 'tp', to: 1 });
  const warp = msgs(a.inbox, 'warp')[0];
  assert.deepEqual([warp.g, warp.n, warp.x, warp.y], [3, 7, 21, 9]);

  world.handle(a.client, { t: 'pvp', to: 1 });
  assert.equal(msgs(b.inbox, 'pvp.req')[0].from, 0);
  world.handle(b.client, { t: 'pvp.accept', from: 0 });
  const start = msgs(a.inbox, 'battle.start')[0];
  assert.equal(start.mode, 'pvp');
  assert.equal(start.party, null); // pvp: real parties, no merge
  world.close();
});

test('shared speed: clamped, broadcast to everyone, replayed in welcome', () => {
  const world = new World(makeCfg());
  const a = join(world, 'A');
  const b = join(world, 'B');

  world.handle(a.client, { t: 'speed', x: 3 });
  assert.equal(msgs(a.inbox, 'speed')[0].x, 3); // setter hears it too
  assert.equal(msgs(b.inbox, 'speed')[0].x, 3);

  world.handle(b.client, { t: 'speed', x: 9 }); // clamped to 4
  assert.equal(msgs(a.inbox, 'speed')[1].x, 4);
  world.handle(b.client, { t: 'speed', x: 4 }); // no change -> no re-broadcast
  assert.equal(msgs(a.inbox, 'speed').length, 2);

  const c = join(world, 'C');
  assert.equal(msgs(c.inbox, 'welcome')[0].speed, 4); // late joiner catches up
  world.close();
});

test('world full rejects a 9th player', () => {
  const world = new World(makeCfg());
  for (let i = 0; i < 8; i++) join(world, `P${i}`);
  const ninth = join(world, 'Nope');
  assert.equal(ninth.client, null);
  assert.equal(msgs(ninth.inbox, 'error')[0].msg, 'world full');
  world.close();
});
