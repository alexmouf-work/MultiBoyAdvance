// The bridge: every frame, drain game→host TLVs from the mailbox and translate
// them onto the wire; queue wire messages back into the host→game ring.
// TLV↔wire mapping: docs/PROTOCOL.md.

import { Mailbox, findMailbox, T, enc, dec, DESPAWN } from './mailbox.js';

const POS_MIN_INTERVAL_MS = 100; // ≤10 pos updates per second
const RESCAN_EVERY_FRAMES = 60;

export class Bridge {
  #adapter;
  #socket;
  #box = null;
  #inQueue = []; // pending {type, payload} for the in-ring (backpressure-safe)
  #framesSinceScan = 0;
  #lastPos = { at: 0, key: '' };
  #sid = null; // current battle session id
  #status = 'searching';
  onStatus = () => {};

  constructor(adapter, socket) {
    this.#adapter = adapter;
    this.#socket = socket;
    this.#wireHandlers();
    adapter.onFrameEnd(() => this.#onFrame());
  }

  get status() {
    return this.#status;
  }

  #setStatus(s) {
    if (this.#status !== s) {
      this.#status = s;
      this.onStatus(s);
    }
  }

  // ---- per-frame exchange ----

  #onFrame() {
    const mem = this.#adapter.memory();
    if (!this.#box || !this.#boxStillValid(mem)) {
      if (this.#framesSinceScan++ % RESCAN_EVERY_FRAMES !== 0) return;
      const base = findMailbox(mem, this.#adapter.memoryBase());
      if (base < 0) {
        this.#setStatus('searching');
        return;
      }
      this.#box = new Mailbox(mem, base);
      this.#box.setHostAttached(1);
      this.#setStatus('attached');
    }
    this.#box.attach(mem, this.#box.base); // heap may have been replaced

    for (const rec of this.#box.readOut()) this.#gameToWire(rec);

    while (this.#inQueue.length) {
      const { type, payload } = this.#inQueue[0];
      if (!this.#box.writeIn(type, payload)) break; // ring full: retry next frame
      this.#inQueue.shift();
    }
  }

  #boxStillValid(mem) {
    if (!this.#box) return false;
    this.#box.attach(mem, this.#box.base);
    return this.#box.valid;
  }

  #queueIn(type, payload) {
    this.#inQueue.push({ type, payload });
    if (this.#inQueue.length > 512) this.#inQueue.splice(0, this.#inQueue.length - 512);
  }

  // ---- game → wire ----

  #gameToWire({ type, payload }) {
    switch (type) {
      case T.HELLO:
        this.#setStatus('game-ready');
        break;
      case T.PRESENCE: {
        const p = dec.presence(payload);
        const key = `${p.g},${p.n},${p.x},${p.y},${p.f},${p.s}`;
        const now = performance.now();
        if (key === this.#lastPos.key) break;
        if (now - this.#lastPos.at < POS_MIN_INTERVAL_MS) {
          this.#lastPos.pending = p; // trailing update sent on next frame past the window
          break;
        }
        this.#lastPos = { at: now, key };
        this.#socket.send({ t: 'pos', ...p });
        break;
      }
      case T.FLAG_SET:
        this.#socket.send({ t: 'flag', id: dec.flag(payload).id });
        break;
      case T.VAR_SET: {
        const v = dec.var(payload);
        this.#socket.send({ t: 'var', id: v.id, v: v.v });
        break;
      }
      case T.PARTY_SUMMARY:
        this.#socket.send({ t: 'party', mons: dec.partySummary(payload) });
        break;
      case T.REQUEST: {
        const r = dec.request(payload);
        if (r.sub === 1) this.#socket.send({ t: 'tp', to: r.arg });
        else if (r.sub === 2) this.#socket.send({ t: 'pvp', to: r.arg });
        else if (r.sub === 3) this.#socket.send({ t: 'pvp.accept', from: r.arg });
        break;
      }
      case T.BATTLE_EVENT: {
        const b = dec.battleEvent(payload);
        if (b.sub === 'encounter') this.#socket.send({ t: 'battle.open', kind: b.kind, opp: b.opp });
        else if (b.sub === 'input' && this.#sid)
          this.#socket.send({ t: 'battle.input', sid: this.#sid, turn: b.turn, a: b.a, move: b.move, tgt: b.tgt, x: b.x });
        else if (b.sub === 'outcome' && this.#sid)
          this.#socket.send({ t: 'battle.end', sid: this.#sid, result: b.result });
        break;
      }
    }
  }

  // ---- wire → game ----

  #wireHandlers() {
    const s = this.#socket;
    s.on('welcome', (m) => {
      this.#queueIn(T.ASSIGN, enc.assign(m.slot));
      for (const id of m.flags ?? []) this.#queueIn(T.FLAG_APPLY, enc.flagApply(id));
      for (const [id, v] of m.vars ?? []) this.#queueIn(T.VAR_APPLY, enc.varApply(id, v));
    });
    s.on('ghost', (m) => {
      const active = m.s === DESPAWN ? 0 : 1;
      this.#queueIn(T.GHOST, enc.ghost(m.slot, active, m.g, m.n, m.x, m.y, m.f, m.s));
    });
    s.on('flag', (m) => this.#queueIn(T.FLAG_APPLY, enc.flagApply(m.id)));
    s.on('var', (m) => this.#queueIn(T.VAR_APPLY, enc.varApply(m.id, m.v)));
    s.on('warp', (m) => this.#queueIn(T.WARP, enc.warp(m.g, m.n, m.x, m.y)));
    s.on('battle.start', (m) => {
      this.#sid = m.sid;
      this.#queueIn(T.BATTLE_CMD, enc.battleStart(m.seed, m.order, m.mode));
    });
    s.on('battle.input', (m) => {
      this.#queueIn(T.BATTLE_CMD, enc.battleTurnRelay(m.turn, m.from, m.a, m.move, m.tgt, m.x));
    });
    s.on('battle.end', (m) => {
      this.#queueIn(T.BATTLE_CMD, enc.battleEnd(m.result));
      this.#sid = null;
    });
  }

  /** UI joins a battle session on the player's behalf. */
  joinBattle(sid) {
    this.#sid = sid;
    this.#socket.send({ t: 'battle.join', sid });
  }
}
