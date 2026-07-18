// The world hub: transport-agnostic multiplayer logic. Transports (WS, TCP)
// hand it connected clients; it routes presence, world state, battles, and
// social messages per docs/PROTOCOL.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorldState } from './state.js';
import { BattleSession } from '../battle/session.js';
import { mergeLineupWire } from '../battle/merge.js';
import { inRanges } from '../protocol.js';
import { runCommand } from '../commands.js';
import { forgeSave, FLASH_SIZE, SECTOR_DATA_SIZE } from '../saveforge.js';

const DESPAWN_STATE = 255;
const TP_REQUEST_TTL_MS = 60_000;
const TRADE_OFFER_TTL_MS = 120_000; // 2 min to answer a trade offer
const TRADE_MAX_ITEMS = 8; // per side
const TRADE_MAX_MONS = 6; // per side
const TEAM_INVITE_TTL_MS = 120_000; // 2 min to answer a team invite
const TEAM_MAX = 3; // members per team (A,B,C → A1,B1,C1,A2,B2,C2)
// SAFETY STOPGAP (see docs/plans/TEAM-BATTLES.md "What went wrong"): the old
// team-battle path injected a merged party into the initiator's live save and
// — with no battle-end report from the ROM — never restored it, so the forge
// persisted the borrowed Pokémon. Auto-starting team battles is DISABLED until
// the single-host rebuild (which never lets a temporary party touch the save)
// ships. Team formation, invites, the line-up builder, and the panel all stay
// live; a wild encounter just runs as a normal solo battle for now.
const TEAM_BATTLES_ENABLED = false;

// Hoenn starters + the kit every new player gets alongside one. These are the
// ROM's INTERNAL Hoenn species order (pokeemerald constants), NOT National Dex
// numbers — sending 252/255/258 lands on unused "??" placeholder slots.
const STARTER_SPECIES = new Set([277, 280, 283]); // Treecko, Torchic, Mudkip
const STARTER_RETRY_MS = 10_000;
const ITEM_POKE_BALL = 4;
const ITEM_POTION = 13;

/**
 * Encode a trainer name into the GBA game's charmap (A-Z, a-z, 0-9, space),
 * truncated to 7 chars and EOS(0xFF)-padded to 8 bytes — the exact payload
 * ADMIN SET_NAME writes into the save. Unmappable characters are dropped.
 */
export function encodePokeName(name) {
  const out = [];
  for (const ch of String(name)) {
    const c = ch.codePointAt(0);
    if (ch === ' ') out.push(0x00);
    else if (c >= 0x30 && c <= 0x39) out.push(0xa1 + c - 0x30); // 0-9
    else if (c >= 0x41 && c <= 0x5a) out.push(0xbb + c - 0x41); // A-Z
    else if (c >= 0x61 && c <= 0x7a) out.push(0xd5 + c - 0x61); // a-z
    if (out.length === 7) break;
  }
  while (out.length < 8) out.push(0xff);
  return out;
}

/** One connected player, wrapped over whatever transport delivered it. */
class Client {
  constructor(id, slot, name, send) {
    this.id = id;
    this.slot = slot;
    this.name = name;
    this.send = send; // (obj) => void, never throws
    this.map = null; // {g, n} once the first pos arrives
    this.pos = { x: 0, y: 0, f: 0, s: 0 };
    this.party = []; // latest party summary [{sp,lv,hp}]
    this.fullMons = []; // latest full wire mons [{lv, b:[32 ints]}]
    this.tpRequests = new Map(); // requester slot -> timestamp (awaiting our accept)
    this.tradeOffers = new Map(); // proposer slot -> {at, give, want} (awaiting our answer)
    this.teamId = null; // id of the team this player belongs to (world.teams)
    this.starterAt = 0; // last starter grant (retryable while the party is empty)
    this.joinedAt = Date.now();
    this.lastSeen = Date.now();
  }
}

export class World {
  /** @param {import('../config.js').config} cfg */
  constructor(cfg) {
    this.cfg = cfg;
    this.state = new WorldState(cfg.dataFile);
    /** @type {Map<number, Client>} slot -> client */
    this.clients = new Map();
    /** @type {Map<string, BattleSession>} sid -> session */
    this.battles = new Map();
    /** @type {Map<string, number>} resume id -> slot (for reconnects) */
    this.resumable = new Map();
    /** @type {Map<string, object>} teamId -> {id, leader, members, invites, lineup} */
    this.teams = new Map();
    this._teamSeq = 1;
    /** Shared emulator speed multiplier (1-4) — one world, one clock. */
    this.speed = 1;
  }

  // ---- connection lifecycle -------------------------------------------------

  /**
   * Register a new connection. Returns the Client, or null if the world is full
   * (an error is sent before returning null).
   * @param {{name?: string, resume?: string}} hello
   * @param {(obj: object) => void} send
   */
  addClient(hello, send) {
    let slot = -1;
    if (hello.resume && this.resumable.has(hello.resume) && !this.clients.has(this.resumable.get(hello.resume))) {
      slot = this.resumable.get(hello.resume);
    } else {
      for (let s = 0; s < this.cfg.maxPlayers; s++) {
        if (!this.clients.has(s)) {
          slot = s;
          break;
        }
      }
    }
    if (slot === -1) {
      send({ t: 'error', msg: 'world full' });
      return null;
    }
    const id = hello.resume && this.resumable.get(hello.resume) === slot ? hello.resume : crypto.randomUUID();
    const name = String(hello.name ?? `Player${slot + 1}`).slice(0, 16);
    const client = new Client(id, slot, name, send);
    this.clients.set(slot, client);
    this.resumable.set(id, slot);
    this.state.touchUser(name); // persistent trainer record (join screen roster)

    client.send({
      t: 'welcome',
      id,
      slot,
      players: [...this.clients.values()]
        .filter((c) => c !== client)
        .map((c) => ({ slot: c.slot, name: c.name, onlineMs: Date.now() - c.joinedAt })),
      users: this.usersSnapshot(),
      flags: [...this.state.flags],
      vars: [...this.state.vars.entries()],
      speed: this.speed,
    });
    this._broadcast({ t: 'join', slot, name }, client);
    this._broadcast({ t: 'users', users: this.usersSnapshot() }, client);
    return client;
  }

  removeClient(client) {
    if (this.clients.get(client.slot) !== client) return;
    this.clients.delete(client.slot);
    this.state.touchUser(client.name); // stamp lastSeenAt for "last seen … ago"
    this._broadcast({ t: 'leave', slot: client.slot });
    this._broadcast({ t: 'users', users: this.usersSnapshot() });
    this._despawnGhost(client, client.map);
    for (const session of this.battles.values()) {
      const i = session.participants.indexOf(client);
      if (i >= 0) session.participants.splice(i, 1);
    }
    // Trade GC: cancel offers the leaver had received (tell the proposers) and
    // drop any pending offers the leaver had made to others.
    for (const [proposerSlot] of client.tradeOffers) {
      this.clients.get(proposerSlot)?.send({ t: 'trade.cancelled', from: client.slot, reason: 'offline' });
    }
    client.tradeOffers.clear();
    for (const c of this.clients.values()) c.tradeOffers.delete(client.slot);
    // Team GC: a leaving member drops out; a leaving LEADER disbands the team.
    const team = this._teamOf(client);
    if (team) this._removeFromTeam(team, client);
  }

  /** Remove a trainer from the registry (offline only). Used by /delete. */
  deleteUser(name) {
    const key = String(name).toLowerCase();
    for (const c of this.clients.values()) {
      if (c.name.toLowerCase() === key) return { ok: false, msg: `${c.name} is online — they must leave first` };
    }
    const u = this.state.deleteUser(key);
    if (!u) return { ok: false, msg: `no trainer named "${name}" — /players` };
    this._broadcast({ t: 'users', users: this.usersSnapshot() });
    return { ok: true, msg: `deleted trainer ${u.name}` };
  }

  /** Every trainer ever seen, with online status and last/current location. */
  usersSnapshot() {
    const online = new Map();
    for (const c of this.clients.values()) online.set(c.name.toLowerCase(), c);
    return [...this.state.users.values()]
      .map((u) => {
        const c = online.get(u.name.toLowerCase());
        return c
          ? { name: c.name, online: true, slot: c.slot, g: c.map?.g, n: c.map?.n, x: c.pos.x, y: c.pos.y }
          : { name: u.name, online: false, g: u.g, n: u.n, x: u.x, y: u.y, lastSeenAt: u.lastSeenAt };
      })
      .sort((a, b) => Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  }

  // ---- message routing ------------------------------------------------------

  /** @param {Client} client @param {any} msg validated by protocol.parseMessage */
  handle(client, msg) {
    client.lastSeen = Date.now();
    switch (msg.t) {
      case 'pos': return this._onPos(client, msg);
      case 'flag': return this._onFlag(client, msg);
      case 'var': return this._onVar(client, msg);
      case 'party': return this._onParty(client, msg);
      case 'party.full': return this._onPartyFull(client, msg);
      case 'battle.open': return this._onBattleOpen(client, msg);
      case 'battle.join': return this._onBattleJoin(client, msg);
      case 'battle.input': return this._onBattleInput(client, msg);
      case 'battle.end': return this._onBattleEnd(client, msg);
      case 'tp': return this._onTeleport(client, msg);
      case 'tp.accept': return this._onTpAccept(client, msg);
      case 'pvp': return this._onPvp(client, msg);
      case 'pvp.accept': return this._onPvpAccept(client, msg);
      case 'trade.give': return this._onTradeGive(client, msg);
      case 'trade.offer': return this._onTradeOffer(client, msg);
      case 'trade.accept': return this._onTradeAccept(client, msg);
      case 'trade.reject': return this._onTradeReject(client, msg);
      case 'team.create': return this._onTeamCreate(client);
      case 'team.invite': return this._onTeamInvite(client, msg);
      case 'team.accept': return this._onTeamAccept(client, msg);
      case 'team.reject': return this._onTeamReject(client, msg);
      case 'team.leave': return this._onTeamLeave(client);
      case 'team.lineup': return this._onTeamLineup(client, msg);
      case 'battle.turn.begin': return this._onBattleTurnBegin(client, msg);
      case 'starter': return this._onStarter(client, msg);
      case 'resync': return this._onResync(client);
      case 'save.blocks': return this._onSaveBlocks(client, msg);
      case 'cmd': return this._onCmd(client, msg);
      case 'speed': return this._onSpeed(client, msg);
      case 'ping': return client.send({ t: 'pong' });
    }
  }

  // ---- presence (soft sync, per-map interest) --------------------------------

  _onPos(client, msg) {
    const prevMap = client.map;
    const map = { g: msg.g, n: msg.n };
    client.pos = { x: msg.x, y: msg.y, f: msg.f, s: msg.s };
    this.state.updateUserPos(client.name, msg.g, msg.n, msg.x, msg.y);
    const mapChanged = !prevMap || prevMap.g !== map.g || prevMap.n !== map.n;
    client.map = map;

    if (mapChanged) {
      this._despawnGhost(client, prevMap);
      // Introduce mover and residents to each other.
      for (const peer of this._peersOnMap(map, client)) {
        peer.send(this._ghostOf(client));
        client.send(this._ghostOf(peer));
      }
    } else {
      for (const peer of this._peersOnMap(map, client)) peer.send(this._ghostOf(client));
    }
  }

  _ghostOf(c) {
    return { t: 'ghost', slot: c.slot, g: c.map.g, n: c.map.n, x: c.pos.x, y: c.pos.y, f: c.pos.f, s: c.pos.s };
  }

  _despawnGhost(client, map) {
    if (!map) return;
    for (const peer of this._peersOnMap(map, client)) {
      peer.send({ t: 'ghost', slot: client.slot, g: map.g, n: map.n, x: 0, y: 0, f: 0, s: DESPAWN_STATE });
    }
  }

  *_peersOnMap(map, except) {
    if (!map) return;
    for (const c of this.clients.values()) {
      if (c !== except && c.map && c.map.g === map.g && c.map.n === map.n) yield c;
    }
  }

  // ---- shared world state -----------------------------------------------------

  _onFlag(client, msg) {
    if (!inRanges(msg.id, this.cfg.syncedFlagRanges)) return;
    if (this.state.setFlag(msg.id)) this._broadcast({ t: 'flag', id: msg.id });
  }

  _onVar(client, msg) {
    if (!inRanges(msg.id, this.cfg.syncedVarRanges)) return;
    if (this.state.setVar(msg.id, msg.v)) this._broadcast({ t: 'var', id: msg.id, v: msg.v });
  }

  _onParty(client, msg) {
    if (!Array.isArray(msg.mons)) return;
    client.party = msg.mons
      .slice(0, 6)
      .map((m) => ({ sp: m.sp | 0, lv: m.lv | 0, hp: m.hp | 0 }));
  }

  _onPartyFull(client, msg) {
    if (!Array.isArray(msg.mons)) return;
    client.fullMons = msg.mons
      .slice(0, 6)
      .filter((m) => Array.isArray(m.b) && m.b.length === 32)
      .map((m) => ({ lv: m.lv | 0, b: m.b.map((x) => x & 0xff) }));
  }

  // ---- teams (docs/plans/TEAM-BATTLES.md T1) ---------------------------------
  // Ephemeral, in-memory. Leader creates + invites (online players only, max
  // 3 members); invites mirror the teleport handshake (stored + TTL, verified
  // at accept). The leader leaving disbands the team.

  _teamOf(client) {
    return client.teamId ? this.teams.get(client.teamId) : null;
  }

  _sendTeamUpdate(team) {
    const members = team.members.map((s) => {
      const c = this.clients.get(s);
      return { slot: s, name: c?.name ?? `P${s + 1}`, party: c?.party ?? [], picks: team.lineup[s] ?? null };
    });
    const payload = { t: 'team.update', id: team.id, leader: team.leader, members };
    for (const s of team.members) this.clients.get(s)?.send(payload);
  }

  _removeFromTeam(team, client) {
    client.teamId = null;
    team.members = team.members.filter((s) => s !== client.slot);
    delete team.lineup[client.slot];
    // Tell the leaver too (no-op after a disconnect — the transport is gone),
    // so their own UI clears without inferring it.
    client.send({ t: 'team.left', slot: client.slot, ...(team.leader === client.slot ? { disbanded: true } : {}) });
    if (team.leader === client.slot || team.members.length === 0) {
      // Leader gone (or nobody left): disband, telling every remaining member.
      for (const s of team.members) {
        const c = this.clients.get(s);
        if (c) {
          c.teamId = null;
          c.send({ t: 'team.left', slot: client.slot, disbanded: true });
        }
      }
      this.teams.delete(team.id);
    } else {
      for (const s of team.members) this.clients.get(s)?.send({ t: 'team.left', slot: client.slot });
      this._sendTeamUpdate(team);
    }
  }

  _onTeamCreate(client) {
    const existing = this._teamOf(client);
    if (existing) return this._sendTeamUpdate(existing); // idempotent
    const team = {
      id: `t${this._teamSeq++}`,
      leader: client.slot,
      members: [client.slot], // team order: leader first (A1,B1,C1 interleave)
      invites: new Map(), // invitee slot -> timestamp
      lineup: {}, // member slot -> ordered party indices (team-builder picks)
    };
    this.teams.set(team.id, team);
    client.teamId = team.id;
    this._sendTeamUpdate(team);
  }

  _onTeamInvite(client, msg) {
    const team = this._teamOf(client);
    if (!team) return client.send({ t: 'error', msg: 'create a team first (/team create)' });
    if (team.leader !== client.slot) return client.send({ t: 'error', msg: 'only the team leader can invite' });
    const target = this.clients.get(msg.to); // online-only by construction
    if (!target || target === client) return client.send({ t: 'error', msg: 'player not available' });
    if (target.teamId) return client.send({ t: 'error', msg: `${target.name} is already in a team` });
    if (team.members.length >= TEAM_MAX) return client.send({ t: 'error', msg: `team is full (max ${TEAM_MAX})` });
    team.invites.set(target.slot, Date.now());
    target.send({ t: 'team.req', from: client.slot, name: client.name });
  }

  _onTeamAccept(client, msg) {
    const leader = this.clients.get(msg.from);
    const team = leader ? this._teamOf(leader) : null;
    if (!team || team.leader !== msg.from) return client.send({ t: 'error', msg: 'that team is gone' });
    const asked = team.invites.get(client.slot);
    team.invites.delete(client.slot);
    if (asked === undefined || Date.now() - asked > TEAM_INVITE_TTL_MS) {
      return client.send({ t: 'error', msg: 'team invite expired' });
    }
    if (client.teamId) return client.send({ t: 'error', msg: 'leave your current team first' });
    if (team.members.length >= TEAM_MAX) return client.send({ t: 'error', msg: `team is full (max ${TEAM_MAX})` });
    team.members.push(client.slot);
    client.teamId = team.id;
    this._sendTeamUpdate(team);
  }

  _onTeamReject(client, msg) {
    const leader = this.clients.get(msg.from);
    const team = leader ? this._teamOf(leader) : null;
    if (!team || !team.invites.delete(client.slot)) return;
    leader.send({ t: 'team.left', slot: client.slot, declined: true });
  }

  _onTeamLeave(client) {
    const team = this._teamOf(client);
    if (team) this._removeFromTeam(team, client);
  }

  _onTeamLineup(client, msg) {
    const team = this._teamOf(client);
    if (!team) return;
    const seen = new Set();
    team.lineup[client.slot] = (Array.isArray(msg.picks) ? msg.picks : [])
      .map((i) => i | 0)
      .filter((i) => i >= 0 && i < 6 && !seen.has(i) && seen.add(i))
      .slice(0, 3);
    this._sendTeamUpdate(team);
  }

  // ---- battles -----------------------------------------------------------------

  _onBattleOpen(client, msg) {
    // A team member's wild encounter pulls every ONLINE member into one shared
    // battle immediately — no join window, regardless of location. With no
    // teammate online the initiator falls through to the normal solo path.
    const team = this._teamOf(client);
    if (TEAM_BATTLES_ENABLED && team) {
      const online = team.members.map((s) => this.clients.get(s)).filter(Boolean);
      if (online.length >= 2) return this._openTeamBattle(client, team, online, msg);
    }
    const session = new BattleSession(
      client,
      { kind: msg.kind, opp: msg.opp },
      this.cfg.battleJoinWindowMs,
      (s) => this._startBattle(s),
    );
    this.battles.set(session.sid, session);
    const offer = { t: 'battle.offer', sid: session.sid, from: client.slot, kind: msg.kind, opp: msg.opp, ttl: this.cfg.battleJoinWindowMs };
    for (const peer of this._peersOnMap(client.map, client)) peer.send(offer);
  }

  _openTeamBattle(client, team, online, msg) {
    const partyWire = mergeLineupWire(online.map((c) => ({
      slot: c.slot,
      fullMons: c.fullMons,
      picks: team.lineup[c.slot] ?? null,
    })));
    // The initiator's ROM ships the exact wild enemy so every peer fights the
    // same mon (determinism input; without it each ROM would roll its own).
    const enemy = Array.isArray(msg.enemy) && msg.enemy.length === 32
      ? [msg.enemy.map((x) => x & 0xff)]
      : null;
    const session = new BattleSession(
      client,
      {
        kind: msg.kind,
        opp: msg.opp,
        mode: 'team',
        enemy,
        teamOrder: online.map((c) => c.slot), // already team order: leader first
        partyWire,
      },
      0,
      (s) => this._startBattle(s),
    );
    this.battles.set(session.sid, session);
    for (const m of online) if (m !== client) session.join(m);
    session.startNow();
  }

  _onBattleTurnBegin(client, msg) {
    this.battles.get(String(msg.sid))?.turnBegin(client, msg.turn);
  }

  _onBattleJoin(client, msg) {
    const session = this.battles.get(String(msg.sid));
    if (session?.join(client)) {
      for (const p of session.participants) {
        if (p !== client) p.send({ t: 'join', slot: client.slot, name: client.name, sid: session.sid });
      }
    }
  }

  _startBattle(session) {
    const payload = session.startPayload();
    for (const p of session.participants) p.send(payload);
  }

  _onBattleInput(client, msg) {
    this.battles.get(String(msg.sid))?.relayInput(client, msg);
  }

  _onBattleEnd(client, msg) {
    const session = this.battles.get(String(msg.sid));
    if (!session) return;
    const outcome = session.end(client, msg.result);
    if (!outcome) return;
    this.battles.delete(session.sid);
    const initiator = session.initiator;
    // Win: everyone regroups at the battle site. Loss: shared whiteout — the
    // ROM handles the Pokémon Center respawn itself; we just broadcast the end.
    const warp =
      outcome.result === 1 && initiator.map
        ? { g: initiator.map.g, n: initiator.map.n, x: initiator.pos.x, y: initiator.pos.y }
        : null;
    for (const p of session.participants) {
      p.send({ t: 'battle.end', sid: session.sid, result: outcome.result, warp: p === initiator ? null : warp });
      if (p !== initiator && warp) p.send({ t: 'warp', ...warp });
    }
  }

  // ---- social --------------------------------------------------------------------

  // Teleport is consensual ("/tpa" style): the requester asks, the target
  // accepts, and only then does the requester get warped to the target.
  _onTeleport(client, msg) {
    const target = this.clients.get(msg.to);
    if (!target || target === client) return client.send({ t: 'error', msg: 'player not available' });
    this.requestTeleport(client, target);
  }

  /** Ask `target` to let `from` teleport to them. Also used by /tp in commands.js. */
  requestTeleport(from, target) {
    target.tpRequests.set(from.slot, Date.now());
    target.send({ t: 'tp.req', from: from.slot, name: from.name });
  }

  _onTpAccept(client, msg) {
    const asked = client.tpRequests.get(msg.from);
    client.tpRequests.delete(msg.from);
    if (asked === undefined || Date.now() - asked > TP_REQUEST_TTL_MS) return;
    const requester = this.clients.get(msg.from);
    if (!requester || !client.map) return;
    requester.send({ t: 'warp', g: client.map.g, n: client.map.n, x: client.pos.x, y: client.pos.y });
  }

  _onPvp(client, msg) {
    const target = this.clients.get(msg.to);
    if (!target) return client.send({ t: 'error', msg: 'player not available' });
    target.send({ t: 'pvp.req', from: client.slot, name: client.name });
  }

  _onPvpAccept(client, msg) {
    const challenger = this.clients.get(msg.from);
    if (!challenger) return client.send({ t: 'error', msg: 'player not available' });
    const session = new BattleSession(challenger, { kind: 0, opp: 0, mode: 'pvp' }, 0, (s) => this._startBattle(s));
    this.battles.set(session.sid, session);
    session.join(client);
    session.startNow();
  }

  // Ghost interaction: hand an item to a nearby player. The item leaves the
  // giver's bag and lands in the receiver's — both via the admin mailbox path.
  _onTradeGive(client, msg) {
    const target = this.clients.get(msg.to);
    const item = msg.item | 0;
    const qty = msg.qty | 0;
    if (!target || target === client) return client.send({ t: 'error', msg: 'player not available' });
    if (item < 1 || item > 0xffff || qty < 1 || qty > 999) return client.send({ t: 'error', msg: 'bad item/qty' });
    client.send({ t: 'admin', sub: 'take_item', item, qty });
    target.send({ t: 'admin', sub: 'give_item', item, qty });
    target.send({ t: 'trade.recv', from: client.slot, name: client.name, item, qty });
  }

  // ---- trading (docs/plans/TRADING.md) ---------------------------------------
  // Any two ONLINE players, unlimited distance. Offer → accept / counter
  // (reject + fresh reverse offer) / reject. Mirrors the teleport handshake:
  // the pending offer lives on the TARGET with a TTL and is verified at accept.
  //
  // Terms shape (one side): { items: [{id, qty}], mons: [...] }.
  //   give.mons — the proposer's OWN party: {slot, sp} (slot authoritative,
  //   species snapshot verified at accept against the server-held wire party).
  //   want.mons — a request from the target, composed blind: {sp} only; the
  //   species is resolved to a party slot of the ACCEPTOR at accept time.

  /** Clamp/normalize one side's terms. `own` = terms refer to the sender's party. */
  _normTradeTerms(terms, own) {
    const t = typeof terms === 'object' && terms !== null ? terms : {};
    const items = (Array.isArray(t.items) ? t.items : [])
      .slice(0, TRADE_MAX_ITEMS)
      .map((i) => ({ id: (i?.id | 0) & 0xffff, qty: Math.min(999, Math.max(1, i?.qty | 0)) }))
      .filter((i) => i.id >= 1);
    const seen = new Set();
    const mons = (Array.isArray(t.mons) ? t.mons : [])
      .slice(0, TRADE_MAX_MONS)
      .map((m) => (own
        ? { slot: m?.slot | 0, sp: (m?.sp | 0) & 0xffff } // own party: slot + snapshot
        : { sp: (m?.sp | 0) & 0xffff })) // blind request: species only
      .filter((m) => m.sp >= 1
        && (!own || (m.slot >= 0 && m.slot < 6 && !seen.has(m.slot) && seen.add(m.slot))));
    return { items, mons };
  }

  _wireSpecies(fullMon) {
    return fullMon ? (fullMon.b[8] | (fullMon.b[9] << 8)) : 0;
  }

  /** Every {slot, sp} still matches the giver's server-held party, and the
   *  giver keeps at least one party mon (an empty overworld party is unsafe). */
  _validGiveMons(giver, mons) {
    if (mons.length === 0) return true;
    if (mons.length >= giver.fullMons.length) return false; // must keep ≥1
    return mons.every((m) => this._wireSpecies(giver.fullMons[m.slot]) === m.sp);
  }

  /** Resolve blind species requests to distinct party slots of `owner`.
   *  @returns {Array<{slot, sp}>|null} null if any species is missing. */
  _resolveWantMons(owner, wantMons) {
    const used = new Set();
    const resolved = [];
    for (const w of wantMons) {
      const slot = owner.fullMons.findIndex(
        (m, i) => !used.has(i) && this._wireSpecies(m) === w.sp,
      );
      if (slot < 0) return null;
      used.add(slot);
      resolved.push({ slot, sp: w.sp });
    }
    if (resolved.length > 0 && resolved.length >= owner.fullMons.length) return null; // must keep ≥1
    return resolved;
  }

  _onTradeOffer(client, msg) {
    const target = this.clients.get(msg.to);
    if (!target || target === client) return client.send({ t: 'error', msg: 'player not available' });
    const give = this._normTradeTerms(msg.give, true);
    const want = this._normTradeTerms(msg.want, false);
    if (!give.items.length && !give.mons.length && !want.items.length && !want.mons.length) {
      return client.send({ t: 'error', msg: 'empty trade' });
    }
    if (!this._validGiveMons(client, give.mons)) {
      return client.send({ t: 'error', msg: 'you cannot offer those Pokémon (check your party; keep at least one)' });
    }
    // A newer offer from the same proposer supersedes the previous one.
    target.tradeOffers.set(client.slot, { at: Date.now(), give, want });
    target.send({ t: 'trade.req', from: client.slot, name: client.name, give, want });
  }

  _onTradeReject(client, msg) {
    if (!client.tradeOffers.delete(msg.from)) return;
    this.clients.get(msg.from)?.send({ t: 'trade.cancelled', from: client.slot, reason: 'rejected' });
  }

  _onTradeAccept(client, msg) {
    const offer = client.tradeOffers.get(msg.from);
    client.tradeOffers.delete(msg.from); // consumed either way
    const proposer = this.clients.get(msg.from);
    const fail = (why) => {
      client.send({ t: 'trade.done', ok: false, with: msg.from, msg: why });
      proposer?.send({ t: 'trade.done', ok: false, with: client.slot, msg: why });
    };
    if (!offer || Date.now() - offer.at > TRADE_OFFER_TTL_MS) return fail('offer expired');
    if (!proposer) return fail('trader went offline');
    // Re-validate BOTH directions against the parties as they are NOW.
    if (!this._validGiveMons(proposer, offer.give.mons)) return fail('their party changed — trade cancelled');
    const wantResolved = this._resolveWantMons(client, offer.want.mons);
    if (!wantResolved) return fail('your party no longer matches the request — trade cancelled');

    this._tradeLeg(proposer, client, offer.give);
    this._tradeLeg(client, proposer, { items: offer.want.items, mons: wantResolved });

    const summary = `${this._describeTerms(offer.give)} ⇄ ${this._describeTerms({ items: offer.want.items, mons: wantResolved })}`;
    client.send({ t: 'trade.done', ok: true, with: proposer.slot, summary });
    proposer.send({ t: 'trade.done', ok: true, with: client.slot, summary });
  }

  /** Execute one direction: giver loses, taker gains. Takes are sent before
   *  gives, and mons in DESCENDING slot order — the ROM compacts the party
   *  after each removal, so ascending order would shift later indices. */
  _tradeLeg(giver, taker, terms) {
    const mons = [...terms.mons].sort((a, b) => b.slot - a.slot);
    for (const m of mons) {
      const wire = giver.fullMons[m.slot]?.b;
      if (!wire) continue; // validated above; belt-and-suspenders
      giver.send({ t: 'admin', sub: 'take_mon', slot: m.slot, sp: m.sp });
      taker.send({ t: 'trade.deliver', from: giver.slot, b: wire });
    }
    for (const it of terms.items) {
      giver.send({ t: 'admin', sub: 'take_item', item: it.id, qty: it.qty });
      taker.send({ t: 'admin', sub: 'give_item', item: it.id, qty: it.qty });
    }
  }

  _describeTerms(terms) {
    const bits = [
      ...terms.mons.map((m) => `#${m.sp}`),
      ...terms.items.map((i) => `item ${i.id}×${i.qty}`),
    ];
    return bits.join(', ') || 'nothing';
  }

  // New-player kit: chosen starter at lv5 (their only Pokémon), plus balls
  // and potions. The real gate is the game save (the picker only shows while
  // the party is empty); the cooldown just stops double-click double-grants.
  // A retry stays possible while the party is STILL empty, so a grant lost to
  // bad timing (e.g. applied before the save existed) can't lock the player
  // out of ever getting a starter.
  _onStarter(client, msg) {
    if (!STARTER_SPECIES.has(msg.species)) return client.send({ t: 'error', msg: 'not a starter' });
    const empty = client.party.length === 0;
    if (client.starterAt && !(empty && Date.now() - client.starterAt > STARTER_RETRY_MS)) return;
    client.starterAt = Date.now();
    client.send({ t: 'admin', sub: 'give_mon', species: msg.species, level: 5 });
    client.send({ t: 'admin', sub: 'give_item', item: ITEM_POKE_BALL, qty: 5 });
    client.send({ t: 'admin', sub: 'give_item', item: ITEM_POTION, qty: 3 });
  }

  // Freeze-free autosave: the bridge ships raw save-block snapshots every
  // ~10s; we forge a byte-exact .sav (saveforge.js) onto the trainer's last
  // stored image and persist it — the game never runs its 2s flash ceremony.
  _onSaveBlocks(client, msg) {
    if (!this.cfg.savesDir) return;
    const now = Date.now();
    if (client.lastForgeAt && now - client.lastForgeAt < 3000) return; // rate limit
    let blocks;
    try {
      blocks = {
        sb2: new Uint8Array(Buffer.from(String(msg.sb2), 'base64')),
        sb1: new Uint8Array(Buffer.from(String(msg.sb1), 'base64')),
        sto: new Uint8Array(Buffer.from(String(msg.sto), 'base64')),
      };
      if (blocks.sb2.length > SECTOR_DATA_SIZE || blocks.sb1.length > 4 * SECTOR_DATA_SIZE
        || blocks.sto.length > 9 * SECTOR_DATA_SIZE) throw new Error('block too large');

      const key = client.name.toLowerCase().replace(/[^a-z0-9 _-]/g, '').trim();
      if (!key) return;
      const file = path.join(this.cfg.savesDir, `${key}.sav`);
      let base = null;
      try {
        const prev = fs.readFileSync(file);
        if (prev.length === FLASH_SIZE) base = new Uint8Array(prev);
      } catch { /* first save for this trainer */ }

      const image = forgeSave(blocks, msg.counter >>> 0, msg.sector & 0xff, base);
      fs.mkdirSync(this.cfg.savesDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, image);
      fs.renameSync(tmp, file);
      client.lastForgeAt = now;
      const u = this.state.users.get(key);
      if (u) {
        u.savedAt = now;
        this.state._scheduleSave();
      }
    } catch (err) {
      client.send({ t: 'error', msg: `save sync rejected: ${err.message}` });
    }
  }

  // A fresh save asks for the world state again: whatever the welcome replay
  // delivered at the title screen was destroyed by new-game initialization.
  // Also (re)apply the player's registered name into the save.
  _onResync(client) {
    client.send({ t: 'sync', flags: [...this.state.flags], vars: [...this.state.vars.entries()] });
    client.send({ t: 'admin', sub: 'set_name', name: encodePokeName(client.name) });
  }

  _onCmd(client, msg) {
    if (typeof msg.line !== 'string' || msg.line.length > 200) {
      return client.send({ t: 'cmd.result', ok: false, msg: 'bad command line' });
    }
    const { ok, msg: text } = runCommand(this, client, msg.line);
    client.send({ t: 'cmd.result', ok, msg: text });
  }

  _onSpeed(client, msg) {
    const x = Math.min(4, Math.max(1, Math.round(msg.x)));
    if (x === this.speed) return;
    this.speed = x;
    this._broadcast({ t: 'speed', x }); // everyone, including the setter
  }

  // ---- misc -----------------------------------------------------------------------

  _broadcast(obj, except = null) {
    for (const c of this.clients.values()) if (c !== except) c.send(obj);
  }

  /** Drop clients that have been silent past the timeout. Called by a transport timer. */
  reapStale(now = Date.now()) {
    for (const c of [...this.clients.values()]) {
      if (now - c.lastSeen > this.cfg.clientTimeoutMs) this.removeClient(c);
    }
  }

  close() {
    for (const s of this.battles.values()) s.dispose();
    this.state.close();
  }
}
