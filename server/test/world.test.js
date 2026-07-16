import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, encodePokeName } from '../src/world/world.js';

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

test('teleport is request/accept: warp lands only after the target accepts', () => {
  const world = new World(makeCfg());
  const a = join(world, 'A');
  const b = join(world, 'B');
  world.handle(b.client, { t: 'pos', g: 3, n: 7, x: 21, y: 9, f: 0, s: 0 });

  world.handle(a.client, { t: 'tp', to: 1 });
  assert.equal(msgs(a.inbox, 'warp').length, 0, 'no warp before the target accepts');
  const req = msgs(b.inbox, 'tp.req')[0];
  assert.equal(req.from, 0);
  assert.equal(req.name, 'A');

  world.handle(b.client, { t: 'tp.accept', from: 0 });
  const warp = msgs(a.inbox, 'warp')[0];
  assert.deepEqual([warp.g, warp.n, warp.x, warp.y], [3, 7, 21, 9]);

  // an accept with no pending request does nothing
  world.handle(b.client, { t: 'tp.accept', from: 0 });
  assert.equal(msgs(a.inbox, 'warp').length, 1);
  world.close();
});

test('pvp handshake starts immediately on accept', () => {
  const world = new World(makeCfg());
  const a = join(world, 'A');
  const b = join(world, 'B');

  world.handle(a.client, { t: 'pvp', to: 1 });
  assert.equal(msgs(b.inbox, 'pvp.req')[0].from, 0);
  world.handle(b.client, { t: 'pvp.accept', from: 0 });
  const start = msgs(a.inbox, 'battle.start')[0];
  assert.equal(start.mode, 'pvp');
  assert.equal(start.party, null); // pvp: real parties, no merge
  world.close();
});

test('console commands route admin messages and reply with cmd.result', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Alex');
  const b = join(world, 'Sam');

  world.handle(a.client, { t: 'cmd', line: '/give sam item 13 3' });
  assert.equal(msgs(a.inbox, 'cmd.result')[0].ok, true);
  assert.deepEqual(msgs(b.inbox, 'admin')[0], { t: 'admin', sub: 'give_item', item: 13, qty: 3 });

  world.handle(a.client, { t: 'cmd', line: '/give p2 mon 252 10' });
  assert.deepEqual(msgs(b.inbox, 'admin')[1], { t: 'admin', sub: 'give_mon', species: 252, level: 10 });

  world.handle(a.client, { t: 'cmd', line: '/setlevel me 1 42' });
  assert.deepEqual(msgs(a.inbox, 'admin')[0], { t: 'admin', sub: 'set_level', slot: 0, level: 42 });

  world.handle(a.client, { t: 'cmd', line: '/battle sam wild 300 25' });
  assert.deepEqual(msgs(b.inbox, 'admin')[2], { t: 'admin', sub: 'wild_battle', species: 300, level: 25 });

  world.handle(a.client, { t: 'cmd', line: '/resettrainer me 621' });
  assert.deepEqual(msgs(a.inbox, 'admin')[1], { t: 'admin', sub: 'reset_trainer', trainer: 621 });

  world.handle(a.client, { t: 'cmd', line: '/warp 1 4 10 12' });
  assert.deepEqual(msgs(a.inbox, 'warp')[0], { t: 'warp', g: 1, n: 4, x: 10, y: 12 });

  // /tp goes through the same request/accept flow as the sidebar button
  world.handle(a.client, { t: 'cmd', line: '/tp sam' });
  assert.equal(msgs(b.inbox, 'tp.req')[0].from, 0);

  world.handle(a.client, { t: 'cmd', line: '/give nobody item 1' });
  assert.equal(msgs(a.inbox, 'cmd.result').at(-1).ok, false);

  world.handle(a.client, { t: 'cmd', line: '/nonsense' });
  assert.match(msgs(a.inbox, 'cmd.result').at(-1).msg, /unknown command/);
  world.close();
});

test('trade.give moves items between bags; starter kit guards double-grants', () => {
  const world = new World(makeCfg());
  const a = join(world, 'A');
  const b = join(world, 'B');

  world.handle(a.client, { t: 'trade.give', to: 1, item: 13, qty: 2 });
  assert.deepEqual(msgs(a.inbox, 'admin')[0], { t: 'admin', sub: 'take_item', item: 13, qty: 2 });
  assert.deepEqual(msgs(b.inbox, 'admin')[0], { t: 'admin', sub: 'give_item', item: 13, qty: 2 });
  assert.equal(msgs(b.inbox, 'trade.recv')[0].from, 0);

  world.handle(a.client, { t: 'trade.give', to: 0, item: 13, qty: 2 }); // self
  assert.equal(msgs(a.inbox, 'error').length, 1);

  world.handle(b.client, { t: 'starter', species: 258 });
  const admins = msgs(b.inbox, 'admin');
  assert.deepEqual(admins[1], { t: 'admin', sub: 'give_mon', species: 258, level: 5 });
  assert.equal(admins[2].sub, 'give_item'); // poké balls
  assert.equal(admins[3].sub, 'give_item'); // potions

  world.handle(b.client, { t: 'starter', species: 252 }); // double-click: ignored
  assert.equal(msgs(b.inbox, 'admin').length, 4);

  // a grant that never landed (party still empty) is retryable after cooldown
  b.client.starterAt = Date.now() - 11_000;
  world.handle(b.client, { t: 'starter', species: 252 });
  assert.equal(msgs(b.inbox, 'admin').length, 7, 'empty party after cooldown → regrant');

  // but once a party exists, no more starters, ever
  b.client.starterAt = Date.now() - 11_000;
  world.handle(b.client, { t: 'party', mons: [{ sp: 258, lv: 5, hp: 100 }] });
  world.handle(b.client, { t: 'starter', species: 252 });
  assert.equal(msgs(b.inbox, 'admin').length, 7);

  world.handle(a.client, { t: 'starter', species: 999 }); // not a starter
  assert.equal(msgs(a.inbox, 'error').length, 2);
  world.close();
});

test('/delete removes offline trainers only', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Keeper');
  const b = join(world, 'Goner');
  world.removeClient(b.client);
  assert.equal(world.usersSnapshot().length, 2);

  // online targets are refused
  world.handle(a.client, { t: 'cmd', line: '/delete keeper' });
  assert.match(msgs(a.inbox, 'cmd.result').at(-1).msg, /online/);

  // offline trainer: deleted, registry broadcast updates
  world.handle(a.client, { t: 'cmd', line: '/delete goner' });
  assert.equal(msgs(a.inbox, 'cmd.result').at(-1).ok, true);
  assert.equal(world.usersSnapshot().length, 1);
  assert.equal(msgs(a.inbox, 'users').at(-1).users.some((u) => u.name === 'Goner'), false);

  world.handle(a.client, { t: 'cmd', line: '/delete goner' }); // already gone
  assert.equal(msgs(a.inbox, 'cmd.result').at(-1).ok, false);
  world.close();
});

test('save.blocks forges a valid .sav into the trainer save store', async () => {
  const { default: fs } = await import('node:fs');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const { readSector, FLASH_SIZE } = await import('../src/saveforge.js');

  const savesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mba-forge-'));
  const world = new World(makeCfg({ savesDir }));
  const a = join(world, 'Alex');

  const b64 = (u8) => Buffer.from(u8).toString('base64');
  const blocks = {
    sb2: b64(Uint8Array.from({ length: 3884 }, (_, i) => i & 0xff)),
    sb1: b64(new Uint8Array(15752).fill(2)),
    sto: b64(new Uint8Array(33744).fill(3)),
  };
  world.handle(a.client, { t: 'save.blocks', counter: 4, sector: 2, ...blocks });

  const file = path.join(savesDir, 'alex.sav');
  const image = new Uint8Array(fs.readFileSync(file));
  assert.equal(image.length, FLASH_SIZE);
  // counter 4 -> new counter 5 -> slot 2; rotation offset 3 puts id 0 at phys 14+3
  const s = readSector(image, 14 + 3);
  assert.equal(s.id, 0);
  assert.equal(s.counter, 5);
  assert.equal(s.data[100], 100);

  // rate limit: an immediate second snapshot is dropped silently
  world.handle(a.client, { t: 'save.blocks', counter: 4, sector: 2, ...blocks });

  // malformed input answers with an error, writes nothing new
  a.client.lastForgeAt = 0;
  world.handle(a.client, { t: 'save.blocks', counter: 4, sector: 2, sb2: 'x', sb1: 'x', sto: 'x' });
  assert.match(msgs(a.inbox, 'error').at(-1).msg, /save sync rejected/);
  world.close();
});

test('resync replays world state and the registered name', () => {
  const world = new World(makeCfg());
  world.state.setFlag(0x321);
  world.state.setVar(0x4092, 7);
  const a = join(world, 'Ab 9z');

  world.handle(a.client, { t: 'resync' });
  const sync = msgs(a.inbox, 'sync')[0];
  assert.deepEqual(sync.flags, [0x321]);
  assert.deepEqual(sync.vars, [[0x4092, 7]]);

  const setName = msgs(a.inbox, 'admin').find((m) => m.sub === 'set_name');
  // 'A'→0xBB, 'b'→0xD6, ' '→0x00, '9'→0xAA, 'z'→0xEE, then EOS padding
  assert.deepEqual(setName.name, [0xbb, 0xd6, 0x00, 0xaa, 0xee, 0xff, 0xff, 0xff]);
  world.close();
});

test('encodePokeName: truncates to 7, drops unmappable chars, EOS-pads', () => {
  assert.deepEqual(encodePokeName('ABCDEFGH'), [0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xff]);
  assert.equal(encodePokeName('Zoé!7').length, 8);
  assert.deepEqual(encodePokeName('Zoé!7'), [0xd4, 0xe3, 0xa8, 0xff, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(encodePokeName(''), [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
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

test('trainer registry: welcome + broadcasts carry online status and locations', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Alex');
  world.handle(a.client, { t: 'pos', g: 0, n: 16, x: 8, y: 4, f: 0, s: 0 });

  const b = join(world, 'Sam');
  const users = msgs(b.inbox, 'welcome')[0].users;
  const alex = users.find((u) => u.name === 'Alex');
  assert.equal(alex.online, true);
  assert.equal(alex.slot, 0);
  assert.deepEqual([alex.g, alex.n, alex.x, alex.y], [0, 16, 8, 4]);
  assert.ok(msgs(a.inbox, 'users').length >= 1, "Sam's arrival updates Alex's registry view");

  // logging out keeps the record, flips it offline at the same spot
  world.removeClient(a.client);
  const after = msgs(b.inbox, 'users').at(-1).users;
  const gone = after.find((u) => u.name === 'Alex');
  assert.equal(gone.online, false);
  assert.deepEqual([gone.g, gone.n, gone.x, gone.y], [0, 16, 8, 4]);
  assert.ok(gone.lastSeenAt <= Date.now());

  // rejoining under different casing reuses the record, not a new one
  join(world, 'alex');
  assert.equal(world.usersSnapshot().length, 2);
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
