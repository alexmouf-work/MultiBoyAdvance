// The world hub: transport-agnostic multiplayer logic. Transports (WS, TCP)
// hand it connected clients; it routes presence, world state, battles, and
// social messages per docs/PROTOCOL.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WorldState } from './state.js';
import { BattleSession } from '../battle/session.js';
import { inRanges } from '../protocol.js';
import { runCommand } from '../commands.js';
import { forgeSave, FLASH_SIZE, SECTOR_DATA_SIZE } from '../saveforge.js';

const DESPAWN_STATE = 255;
const TP_REQUEST_TTL_MS = 60_000;

// Hoenn starters + the kit every new player gets alongside one.
const STARTER_SPECIES = new Set([252, 255, 258]); // Treecko, Torchic, Mudkip
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
