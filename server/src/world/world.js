// The world hub: transport-agnostic multiplayer logic. Transports (WS, TCP)
// hand it connected clients; it routes presence, world state, battles, and
// social messages per docs/PROTOCOL.md.

import crypto from 'node:crypto';
import { WorldState } from './state.js';
import { BattleSession } from '../battle/session.js';
import { inRanges } from '../protocol.js';

const DESPAWN_STATE = 255;

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

    client.send({
      t: 'welcome',
      id,
      slot,
      players: [...this.clients.values()]
        .filter((c) => c !== client)
        .map((c) => ({ slot: c.slot, name: c.name })),
      flags: [...this.state.flags],
      vars: [...this.state.vars.entries()],
      speed: this.speed,
    });
    this._broadcast({ t: 'join', slot, name }, client);
    return client;
  }

  removeClient(client) {
    if (this.clients.get(client.slot) !== client) return;
    this.clients.delete(client.slot);
    this._broadcast({ t: 'leave', slot: client.slot });
    this._despawnGhost(client, client.map);
    for (const session of this.battles.values()) {
      const i = session.participants.indexOf(client);
      if (i >= 0) session.participants.splice(i, 1);
    }
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
      case 'pvp': return this._onPvp(client, msg);
      case 'pvp.accept': return this._onPvpAccept(client, msg);
      case 'speed': return this._onSpeed(client, msg);
      case 'ping': return client.send({ t: 'pong' });
    }
  }

  // ---- presence (soft sync, per-map interest) --------------------------------

  _onPos(client, msg) {
    const prevMap = client.map;
    const map = { g: msg.g, n: msg.n };
    client.pos = { x: msg.x, y: msg.y, f: msg.f, s: msg.s };
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

  // ---- battles -----------------------------------------------------------------

  _onBattleOpen(client, msg) {
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

  _onTeleport(client, msg) {
    const target = this.clients.get(msg.to);
    if (!target?.map) return client.send({ t: 'error', msg: 'player not available' });
    client.send({ t: 'warp', g: target.map.g, n: target.map.n, x: target.pos.x, y: target.pos.y });
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
