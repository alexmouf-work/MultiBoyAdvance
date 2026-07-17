// Team battles (docs/plans/TEAM-BATTLES.md): T1 formation (create / invite /
// accept / decline / leave / disband / lineup) and T2 session (interleaved
// lineup merge, enemy transfer, controller rotation with dedupe).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/world/world.js';
import { mergeLineupWire, defaultTopPicks } from '../src/battle/merge.js';

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

function wireMon(sp, lv = 10) {
  const b = new Array(32).fill(0);
  b[8] = sp & 0xff;
  b[9] = sp >> 8;
  b[20] = lv;
  return { lv, b };
}

function setParty(world, client, mons /* [{sp, lv}] */) {
  world.handle(client, { t: 'party', mons: mons.map((m) => ({ ...m, hp: 100 })) });
  world.handle(client, { t: 'party.full', mons: mons.map((m) => wireMon(m.sp, m.lv)) });
}

/** Create a 2-member team: Ann leads, Ben joins. */
function makeTeam(world, a, b) {
  world.handle(a.client, { t: 'team.create' });
  world.handle(a.client, { t: 'team.invite', to: b.client.slot });
  world.handle(b.client, { t: 'team.accept', from: a.client.slot });
}

test('team formation: create, invite (online only), accept, roster updates', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');

  world.handle(a.client, { t: 'team.create' });
  assert.equal(msgs(a.inbox, 'team.update').at(-1).leader, 0);

  // Inviting an offline slot fails; a real one lands as team.req.
  world.handle(a.client, { t: 'team.invite', to: 6 });
  assert.match(msgs(a.inbox, 'error').at(-1).msg, /not available/);
  world.handle(a.client, { t: 'team.invite', to: 1 });
  const req = msgs(b.inbox, 'team.req')[0];
  assert.equal(req.from, 0);
  assert.equal(req.name, 'Ann');

  world.handle(b.client, { t: 'team.accept', from: 0 });
  const upd = msgs(b.inbox, 'team.update').at(-1);
  assert.deepEqual(upd.members.map((m) => m.slot), [0, 1]); // leader first
  assert.equal(b.client.teamId, a.client.teamId);
  world.close();
});

test('invite guards: non-leader, already-teamed, full team, expiry, decline', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  const c = join(world, 'Cyn');
  const d = join(world, 'Dee');
  makeTeam(world, a, b);

  // Ben (member, not leader) cannot invite.
  world.handle(b.client, { t: 'team.invite', to: 2 });
  assert.match(msgs(b.inbox, 'error').at(-1).msg, /leader/);

  // Cyn declines; the leader hears it.
  world.handle(a.client, { t: 'team.invite', to: 2 });
  world.handle(c.client, { t: 'team.reject', from: 0 });
  assert.equal(msgs(a.inbox, 'team.left').at(-1).declined, true);
  // A stale accept after the decline consumed the invite fails.
  world.handle(c.client, { t: 'team.accept', from: 0 });
  assert.match(msgs(c.inbox, 'error').at(-1).msg, /expired|gone/);

  // Fill to 3 (max): the next invite is refused.
  world.handle(a.client, { t: 'team.invite', to: 2 });
  world.handle(c.client, { t: 'team.accept', from: 0 });
  world.handle(a.client, { t: 'team.invite', to: 3 });
  assert.match(msgs(a.inbox, 'error').at(-1).msg, /full/);

  // A teamed player can't be invited elsewhere.
  world.handle(d.client, { t: 'team.create' });
  world.handle(d.client, { t: 'team.invite', to: 1 });
  assert.match(msgs(d.inbox, 'error').at(-1).msg, /already in a team/);
  world.close();
});

test('leave and disband: member leaving shrinks, leader leaving dissolves', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  const c = join(world, 'Cyn');
  makeTeam(world, a, b);
  world.handle(a.client, { t: 'team.invite', to: 2 });
  world.handle(c.client, { t: 'team.accept', from: 0 });

  world.handle(b.client, { t: 'team.leave' });
  assert.equal(b.client.teamId, null);
  assert.deepEqual(msgs(a.inbox, 'team.update').at(-1).members.map((m) => m.slot), [0, 2]);

  // Leader disconnects -> disband; Cyn is told and freed.
  world.removeClient(a.client);
  assert.equal(msgs(c.inbox, 'team.left').at(-1).disbanded, true);
  assert.equal(c.client.teamId, null);
  assert.equal(world.teams.size, 0);
  world.close();
});

test('lineup picks: validated, deduped, broadcast; default is top-3 by level', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  makeTeam(world, a, b);
  setParty(world, a.client, [{ sp: 252, lv: 10 }, { sp: 261, lv: 30 }, { sp: 263, lv: 20 }]);

  world.handle(a.client, { t: 'team.lineup', picks: [2, 2, -1, 9, 0, 1, 5] });
  const upd = msgs(a.inbox, 'team.update').at(-1);
  assert.deepEqual(upd.members[0].picks, [2, 0, 1]); // deduped, clamped to 3

  // defaultTopPicks: by level desc, tie-break earlier index.
  assert.deepEqual(defaultTopPicks([{ lv: 10 }, { lv: 30 }, { lv: 20 }, { lv: 30 }]), [1, 3, 2]);
  world.close();
});

test('mergeLineupWire interleaves by rank: A1,B1,A2,B2,A3,B3', () => {
  const A = [wireMon(101, 5), wireMon(102, 6), wireMon(103, 7)];
  const B = [wireMon(201, 5), wireMon(202, 6), wireMon(203, 7)];
  const merged = mergeLineupWire([
    { slot: 0, fullMons: A, picks: [0, 1, 2] },
    { slot: 1, fullMons: B, picks: [2, 0] }, // partial picks are fine
  ]);
  const species = merged.map((b) => b[8] | (b[9] << 8));
  assert.deepEqual(species, [101, 203, 102, 201, 103]); // A1,B1,A2,B2,A3
  // No picks -> top-3 by level.
  const auto = mergeLineupWire([{ slot: 0, fullMons: A, picks: null }]);
  assert.deepEqual(auto.map((b) => b[8]), [103 & 0xff, 102 & 0xff, 101 & 0xff]);
});

test('a team member’s encounter starts one shared battle for all online members', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  const c = join(world, 'Cyn'); // not in the team — must hear nothing
  makeTeam(world, a, b);
  setParty(world, a.client, [{ sp: 252, lv: 10 }, { sp: 261, lv: 30 }]);
  setParty(world, b.client, [{ sp: 283, lv: 20 }, { sp: 285, lv: 15 }]);
  world.handle(b.client, { t: 'team.lineup', picks: [1, 0] });

  const enemy = wireMon(286, 9).b;
  // BEN (not the leader) hits the encounter — he takes the first turn.
  world.handle(b.client, { t: 'battle.open', kind: 0, opp: 286, enemy });

  const started = msgs(b.inbox, 'battle.start')[0];
  assert.ok(started, 'initiator got battle.start');
  assert.equal(started.mode, 'team');
  assert.equal(started.init, 1, 'the encounter opener is the first controller');
  assert.deepEqual(started.order, [0, 1], 'order stays leader-first');
  assert.deepEqual(started.enemy, [enemy], 'the exact enemy ships to everyone');
  // Lineup: Ann auto top-2 (261,252 by level), Ben picked (285,283) →
  // interleave A1,B1,A2,B2 = 261,285,252,283.
  assert.deepEqual(started.partyWire.map((w) => w[8] | (w[9] << 8)), [261, 285, 252, 283]);
  assert.deepEqual(msgs(a.inbox, 'battle.start')[0], started, 'identical payload to the teammate');
  assert.equal(msgs(c.inbox, 'battle.start').length, 0, 'outsiders are not pulled in');
  assert.equal(msgs(c.inbox, 'battle.offer').length, 0, 'no join-window offer in team mode');
  world.close();
});

test('turn controller rotates from the initiator; reports are deduped', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  makeTeam(world, a, b);
  setParty(world, a.client, [{ sp: 252, lv: 10 }, { sp: 261, lv: 30 }]);
  setParty(world, b.client, [{ sp: 283, lv: 20 }, { sp: 285, lv: 15 }]);
  world.handle(b.client, { t: 'battle.open', kind: 0, opp: 286, enemy: wireMon(286, 9).b });
  const sid = msgs(b.inbox, 'battle.start')[0].sid;

  // Both ROMs report turn 0; only ONE battle.turn goes out, controller = Ben (init).
  world.handle(a.client, { t: 'battle.turn.begin', sid, turn: 0 });
  world.handle(b.client, { t: 'battle.turn.begin', sid, turn: 0 });
  assert.equal(msgs(a.inbox, 'battle.turn').length, 1);
  assert.deepEqual(msgs(a.inbox, 'battle.turn')[0], { t: 'battle.turn', sid, turn: 0, controller: 1 });

  // Turn 1 rotates to Ann, turn 2 back to Ben.
  world.handle(a.client, { t: 'battle.turn.begin', sid, turn: 1 });
  assert.equal(msgs(b.inbox, 'battle.turn').at(-1).controller, 0);
  world.handle(b.client, { t: 'battle.turn.begin', sid, turn: 2 });
  assert.equal(msgs(a.inbox, 'battle.turn').at(-1).controller, 1);
  world.close();
});

test('with no teammate online the encounter falls back to the solo join-window path', () => {
  const world = new World(makeCfg());
  const a = join(world, 'Ann');
  const b = join(world, 'Ben');
  makeTeam(world, a, b);
  world.removeClient(b.client); // partner gone (team survives: Ben was not leader…
  // …actually Ben leaving removes him from the team; Ann remains alone in it)

  world.handle(a.client, { t: 'battle.open', kind: 0, opp: 300 });
  assert.equal(msgs(a.inbox, 'battle.start').length, 0, 'no instant team session');
  assert.equal(world.battles.size, 1, 'a normal join-window session opened instead');
  world.close();
});
