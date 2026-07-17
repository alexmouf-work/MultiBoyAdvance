// Battle session lifecycle. docs/PROTOCOL.md §2 (battle.* messages).
//
//   open ──(join window elapses, ≥2 participants)──▶ active ──▶ ended
//     └──(window elapses, initiator alone)──▶ closed silently: the initiator's
//        ROM simply continues its local single-player battle.

import crypto from 'node:crypto';
import { mergeParties, mergeWireParties } from './merge.js';

let nextSessionNum = 1;

export class BattleSession {
  /**
   * @param {object} initiator client (see world.js Client shape)
   * @param {{kind: number, opp: number, mode?: string}} info
   * @param {number} joinWindowMs
   * @param {(session: BattleSession) => void} onStart
   */
  constructor(initiator, info, joinWindowMs, onStart) {
    this.sid = `b${nextSessionNum++}`;
    this.state = 'open';
    this.kind = info.kind;
    this.opp = info.opp;
    this.mode = info.mode ?? 'coop';
    // Team mode (docs/plans/TEAM-BATTLES.md): the enemy wire mon(s) shipped by
    // the initiator, the fixed team order (leader first), and the pre-merged
    // lineup party. Turn control rotates from the initiator through teamOrder.
    this.enemy = info.enemy ?? null; // [[32 ints], …] or null
    this.teamOrder = info.teamOrder ?? null; // [slots], leader first
    this.partyWire = info.partyWire ?? null; // pre-built lineup merge
    this.participants = [initiator];
    this.seed = crypto.randomInt(0, 0x1_0000_0000);
    this._turnsSeen = new Set(); // dedupe: every ROM reports each TURN_BEGIN
    this._onStart = onStart;
    this._timer =
      joinWindowMs > 0 ? setTimeout(() => this.closeWindow(), joinWindowMs) : null;
    this._timer?.unref?.();
  }

  get initiator() {
    return this.participants[0];
  }

  join(client) {
    if (this.state !== 'open') return false;
    if (this.participants.includes(client)) return false;
    this.participants.push(client);
    return true;
  }

  /** End of the join window: either start a shared battle or dissolve. */
  closeWindow() {
    if (this.state !== 'open') return;
    if (this._timer) clearTimeout(this._timer);
    if (this.participants.length < 2) {
      this.state = 'ended';
      return;
    }
    this.state = 'active';
    this._onStart(this);
  }

  /** PvP sessions skip the window and start as soon as both sides are in. */
  startNow() {
    if (this.state !== 'open') return;
    if (this._timer) clearTimeout(this._timer);
    this.state = 'active';
    this._onStart(this);
  }

  startPayload() {
    const bags = {};
    for (const p of this.participants) bags[p.slot] = true; // own-bag marker; item lists stay client-side
    if (this.mode === 'team') {
      // Lineup + enemy are pre-built by the world (mergeLineupWire); order is
      // the TEAM order (leader first), and `init` marks the encounter opener —
      // controller(turn) = order[(indexOf(init) + turn) % order.length].
      return {
        t: 'battle.start',
        sid: this.sid,
        seed: this.seed,
        order: this.teamOrder ?? this.participants.map((p) => p.slot),
        init: this.initiator.slot,
        mode: 'team',
        party: null,
        partyWire: this.partyWire?.length ? this.partyWire : null,
        enemy: this.enemy,
        bags,
      };
    }
    const order = this.participants.map((p) => p.slot);
    const isPvp = this.mode === 'pvp'; // PvP: each ROM fields its own real party
    const party = isPvp
      ? null
      : mergeParties(this.participants.map((p) => ({ slot: p.slot, mons: p.party })));
    const partyWire = isPvp
      ? null
      : mergeWireParties(this.participants.map((p) => ({ slot: p.slot, fullMons: p.fullMons })));
    return {
      t: 'battle.start',
      sid: this.sid,
      seed: this.seed,
      order,
      mode: this.mode,
      party,
      partyWire: partyWire?.length ? partyWire : null,
      bags,
    };
  }

  /** Whose choice drives this turn (team mode): rotate from the initiator
   *  through the team order — turn 0 = the member who hit the encounter. */
  controllerFor(turn) {
    const order = this.teamOrder ?? this.participants.map((p) => p.slot);
    const initIdx = Math.max(0, order.indexOf(this.initiator.slot));
    return order[(initIdx + turn) % order.length];
  }

  /** A ROM reported the start of a turn's action selection. Every participant
   *  reports each turn; the first report wins and is fanned out to all. */
  turnBegin(from, turn) {
    if (this.state !== 'active' || this.mode !== 'team') return;
    if (!Number.isInteger(turn) || turn < 0 || this._turnsSeen.has(turn)) return;
    this._turnsSeen.add(turn);
    const out = { t: 'battle.turn', sid: this.sid, turn, controller: this.controllerFor(turn) };
    for (const p of this.participants) p.send(out);
  }

  relayInput(from, msg) {
    if (this.state !== 'active') return;
    const out = {
      t: 'battle.input',
      sid: this.sid,
      turn: msg.turn,
      from: from.slot,
      a: msg.a,
      move: msg.move ?? 0,
      tgt: msg.tgt ?? 0,
      x: msg.x ?? 0,
    };
    for (const p of this.participants) if (p !== from) p.send(out);
  }

  /**
   * @returns {{result: number, warp: object|null}|null} end info, once
   */
  end(from, result) {
    if (this.state === 'ended') return null;
    if (from !== this.initiator) return null; // initiator reports the outcome
    if (this._timer) clearTimeout(this._timer);
    this.state = 'ended';
    return { result };
  }

  dispose() {
    if (this._timer) clearTimeout(this._timer);
    this.state = 'ended';
  }
}
