// Demo adapter — a miniature "game" that implements the GAME side of the
// mailbox contract in JS: it owns a real 1048-byte mailbox, writes PRESENCE /
// PARTY / BATTLE_EVENT TLVs, and applies GHOST / WARP / BATTLE_CMD TLVs, while
// rendering a tile grid to the canvas. It exists so the entire multiplayer
// stack (bridge → wire → server → peers) runs and can be e2e-tested with no
// ROM and no emulator. The bridge cannot tell it apart from the real thing.

import {
  Mailbox, MAILBOX_SIZE, MAILBOX_MAGIC, PROTO_VERSION, GAME_STATE, DESPAWN, T, enc, dec,
} from '../bridge/mailbox.js';

const TILE = 24;
const COLS = 20;
const ROWS = 12;
const PLAYER_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f5a623', '#8e4ec6', '#00b3c2', '#d6409f', '#846358'];

export class DemoAdapter {
  kind = 'demo';
  #frameCbs = [];
  #mem = new Uint8Array(MAILBOX_SIZE + 64); // mailbox at offset 32, some padding around
  #box = null;
  #ctx = null;
  #raf = 0;

  // demo game state
  me = { g: 0, n: 9, x: 5, y: 5, f: 2, s: 0 };
  ghosts = new Map(); // slot -> {x,y,f,s,g,n}
  battle = null; // {seed, order, mode} once started
  events = []; // human-readable log the page can read (and e2e can assert on)

  async init(canvas) {
    canvas.width = COLS * TILE;
    canvas.height = ROWS * TILE;
    this.#ctx = canvas.getContext('2d');

    // Plant the mailbox exactly like the ROM does.
    const base = 32;
    this.#mem.set(MAILBOX_MAGIC, base);
    this.#mem[base + 4] = PROTO_VERSION;
    this.#box = new Mailbox(this.#mem, base);
    this.#mem[base + 5] = GAME_STATE.OVERWORLD;

    this.#box.writeIn; // (no-op; keeps shape obvious)
    this._outHello();
    this._outPresence();
    this._outParty();

    window.addEventListener('keydown', (e) => this.#onKey(e));

    const loop = () => {
      this.#tick();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  async loadROM() {
    /* demo mode has no ROM */
  }

  onFrameEnd(cb) {
    this.#frameCbs.push(cb);
  }

  memory() {
    return this.#mem;
  }

  memoryBase() {
    return 0;
  }

  // ---- the "game" ----

  #move(dx, dy, facing) {
    if (this.battle) return; // locked in battle
    this.me.x = Math.max(0, Math.min(COLS - 1, this.me.x + dx));
    this.me.y = Math.max(0, Math.min(ROWS - 1, this.me.y + dy));
    this.me.f = facing;
    this._outPresence();
  }

  #onKey(e) {
    const dirs = {
      ArrowUp: [0, -1, 1], ArrowDown: [0, 1, 2], ArrowLeft: [-1, 0, 3], ArrowRight: [1, 0, 4],
      w: [0, -1, 1], s: [0, 1, 2], a: [-1, 0, 3], d: [1, 0, 4],
    };
    const d = dirs[e.key];
    if (!d) return;
    e.preventDefault();
    this.#move(d[0], d[1], d[2]);
  }

  // Touch-control hooks (same interface as the mGBA adapter).
  buttonDown(name) {
    const dirs = { Up: [0, -1, 1], Down: [0, 1, 2], Left: [-1, 0, 3], Right: [1, 0, 4] };
    const d = dirs[name];
    if (d) this.#move(d[0], d[1], d[2]);
  }

  buttonUp() {}

  setSpeed(x) {
    this.events.push({ t: 'speed', x });
  }

  /** Demo UI hook: pretend a wild encounter started. */
  startEncounter() {
    this._out(T.BATTLE_EVENT, enc.battleEncounter(0, 261 /* Poochyena */));
    this.events.push({ t: 'encounter.open' });
  }

  /** Demo UI hook: report battle outcome (initiator side). */
  endBattle(result) {
    this._out(T.BATTLE_EVENT, enc.battleOutcome(result));
    this.battle = null;
    this.events.push({ t: 'battle.ended', result });
  }

  #tick() {
    const b = this.#box;
    // frameCounter++ like NetTick() does
    const fc = (b.frameCounter + 1) & 0xffff;
    this.#mem[b.base + 6] = fc & 0xff;
    this.#mem[b.base + 7] = fc >> 8;

    // Apply host → game TLVs (this is the part net_mailbox.c does in C).
    for (const { type, payload } of b._readRing(532)) {
      switch (type) {
        case T.GHOST: {
          const g = dec.ghost(payload);
          if (!g.active || g.s === DESPAWN) this.ghosts.delete(g.slot);
          else this.ghosts.set(g.slot, g);
          break;
        }
        case T.WARP: {
          const w = dec.warp(payload);
          Object.assign(this.me, { g: w.g, n: w.n, x: w.x, y: w.y });
          this.events.push({ t: 'warped', ...w });
          this._outPresence();
          break;
        }
        case T.ASSIGN:
          this.events.push({ t: 'assigned', slot: dec.assign(payload).slot });
          break;
        case T.FLAG_APPLY:
          this.events.push({ t: 'flag.applied', id: dec.flag(payload).id });
          break;
        case T.BATTLE_CMD: {
          const c = dec.battleCmd(payload);
          if (c.sub === 'start') {
            this.battle = c;
            this.events.push({ t: 'battle.started', seed: c.seed, order: c.order, mode: c.mode });
          } else if (c.sub === 'party') {
            this.events.push({ t: 'battle.party', count: c.mons.length });
          } else if (c.sub === 'input') {
            this.events.push({ t: 'battle.input', from: c.from, a: c.a });
          } else if (c.sub === 'end') {
            this.battle = null;
            this.events.push({ t: 'battle.ended', result: c.result });
          }
          break;
        }
      }
    }

    this.#draw();
    for (const cb of this.#frameCbs) cb();
  }

  _out(type, payload) {
    this.#box._writeRing(16, type, payload);
  }

  _outHello() {
    this._out(T.HELLO, enc.hello());
  }

  _outPresence() {
    const m = this.me;
    this._out(T.PRESENCE, enc.presence(m.g, m.n, m.x, m.y, m.f, m.s));
  }

  _outParty() {
    // A fake but plausible party so co-op merges have something to chew on.
    const party = [
      { sp: 252, lv: 34, hp: 100 }, // Treecko line
      { sp: 261, lv: 28, hp: 100 },
      { sp: 263, lv: 21, hp: 90 },
    ];
    this._out(T.PARTY_SUMMARY, enc.partySummary(party));
    // Matching synthetic wire mons (§1.5) so battle.start carries partyWire.
    const wire = party.map((m, i) => {
      const b = new Array(32).fill(0);
      b[0] = 0x40 + i; // personality
      b[4] = 0x77; // otId
      b[8] = m.sp & 0xff;
      b[9] = m.sp >> 8;
      b[12] = 33; // move 1: tackle
      b[20] = m.lv;
      return b;
    });
    this._out(T.PARTY_FULL, enc.partyFull(wire));
  }

  /** Demo UI hook: set a story flag locally (as if a boss was beaten). */
  setStoryFlag(id) {
    this._out(T.FLAG_SET, enc.flagSet(id));
  }

  /** Demo UI hooks for social features. */
  requestTeleport(slot) {
    this._out(T.REQUEST, enc.request(1, slot));
  }

  #draw() {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.fillStyle = '#10251a';
    ctx.fillRect(0, 0, COLS * TILE, ROWS * TILE);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let cx = 0; cx <= COLS; cx++) {
      ctx.beginPath(); ctx.moveTo(cx * TILE, 0); ctx.lineTo(cx * TILE, ROWS * TILE); ctx.stroke();
    }
    for (let cy = 0; cy <= ROWS; cy++) {
      ctx.beginPath(); ctx.moveTo(0, cy * TILE); ctx.lineTo(COLS * TILE, cy * TILE); ctx.stroke();
    }

    const drawPawn = (x, y, color, label) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x * TILE + TILE / 2, y * TILE + TILE / 2, TILE * 0.36, 0, Math.PI * 2);
      ctx.fill();
      if (label != null) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '10px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(String(label), x * TILE + TILE / 2, y * TILE - 2);
      }
    };

    for (const [slot, g] of this.ghosts) {
      if (g.g === this.me.g && g.n === this.me.n) {
        drawPawn(g.x, g.y, PLAYER_COLORS[slot % 8], `P${slot + 1}`);
      }
    }
    drawPawn(this.me.x, this.me.y, '#eaeaea', 'you');

    if (this.battle) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, COLS * TILE, ROWS * TILE);
      ctx.fillStyle = '#fff';
      ctx.font = '16px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(
        `battle! seed=${this.battle.seed >>> 0} order=[${this.battle.order.join(',')}] ${this.battle.mode}`,
        (COLS * TILE) / 2,
        (ROWS * TILE) / 2,
      );
    }
  }
}
