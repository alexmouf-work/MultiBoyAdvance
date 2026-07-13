// Battle session lifecycle. docs/PROTOCOL.md §2 (battle.* messages).
//
//   open ──(join window elapses, ≥2 participants)──▶ active ──▶ ended
//     └──(window elapses, initiator alone)──▶ closed silently: the initiator's
//        ROM simply continues its local single-player battle.

import crypto from 'node:crypto';
import { mergeParties } from './merge.js';

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
    this.participants = [initiator];
    this.seed = crypto.randomInt(0, 0x1_0000_0000);
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
    const order = this.participants.map((p) => p.slot);
    const party =
      this.mode === 'pvp'
        ? null // PvP: each ROM fields its own real party
        : mergeParties(
            this.participants.map((p) => ({ slot: p.slot, mons: p.party })),
          );
    const bags = {};
    for (const p of this.participants) bags[p.slot] = true; // own-bag marker; item lists stay client-side
    return { t: 'battle.start', sid: this.sid, seed: this.seed, order, mode: this.mode, party, bags };
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
