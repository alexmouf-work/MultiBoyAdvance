// EWRAM mailbox codec — the JS mirror of rom/overlay/include/net/mailbox.h.
// Layout and message types: docs/PROTOCOL.md §1. All values little-endian.

export const MAILBOX_MAGIC = [0x4d, 0x42, 0x41, 0x30]; // "MBA0"
export const PROTO_VERSION = 1;
export const MAILBOX_SIZE = 1048;
export const RING_SIZE = 512;

const OFF_MAGIC = 0;
const OFF_VERSION = 4;
const OFF_GAME_STATE = 5;
const OFF_FRAME = 6;
const OFF_PLAYER_SLOT = 8;
const OFF_HOST_ATTACHED = 9;
const OFF_OUT = 16; // head u16, tail u16, buf[512]
const OFF_IN = 532;

// Game → host TLV types
export const T = {
  PRESENCE: 0x01,
  FLAG_SET: 0x02,
  VAR_SET: 0x03,
  PARTY_SUMMARY: 0x05,
  REQUEST: 0x06,
  PARTY_FULL: 0x07,
  LOG: 0x0f,
  BATTLE_EVENT: 0x10,
  SAVED: 0x11,
  HELLO: 0x7f,
  // Host → game
  GHOST: 0x81,
  FLAG_APPLY: 0x82,
  VAR_APPLY: 0x83,
  WARP: 0x85,
  ASSIGN: 0x86,
  BATTLE_CMD: 0x90,
  ADMIN: 0x91,
};

export const GAME_STATE = { BOOT: 0, OVERWORLD: 1, BATTLE: 2, MENU: 3, OTHER: 4 };
export const DESPAWN = 255;
export const MON_WIRE_SIZE = 32; // §1.5 wire mon (level lives at byte 20)

/**
 * Scan a byte view for the mailbox magic at 4-byte-aligned offsets.
 * @param {Uint8Array} bytes
 * @returns {number} offset of the struct, or -1
 */
export function findMailbox(bytes, from = 0, to = bytes.length - MAILBOX_SIZE) {
  const [m0, m1, m2, m3] = MAILBOX_MAGIC;
  for (let i = from & ~3; i <= to; i += 4) {
    if (bytes[i] === m0 && bytes[i + 1] === m1 && bytes[i + 2] === m2 && bytes[i + 3] === m3 &&
        bytes[i + 4] === PROTO_VERSION) {
      return i;
    }
  }
  return -1;
}

/** A live view over a located mailbox. `bytes` may be re-supplied per frame
 *  (Emscripten heap growth replaces the underlying buffer). */
export class Mailbox {
  constructor(bytes, base) {
    this.attach(bytes, base);
  }

  attach(bytes, base) {
    this.bytes = bytes;
    this.base = base;
  }

  get valid() {
    const b = this.bytes, o = this.base;
    return MAILBOX_MAGIC.every((v, i) => b[o + i] === v) && b[o + OFF_VERSION] === PROTO_VERSION;
  }

  _u16(off) { return this.bytes[this.base + off] | (this.bytes[this.base + off + 1] << 8); }
  _setU16(off, v) {
    this.bytes[this.base + off] = v & 0xff;
    this.bytes[this.base + off + 1] = (v >> 8) & 0xff;
  }

  get frameCounter() { return this._u16(OFF_FRAME); }
  get gameState() { return this.bytes[this.base + OFF_GAME_STATE]; }
  setPlayerSlot(slot) { this.bytes[this.base + OFF_PLAYER_SLOT] = slot; }
  setHostAttached(v) { this.bytes[this.base + OFF_HOST_ATTACHED] = v ? 1 : 0; }

  /** Drain every complete TLV record from the out-ring (game → host). */
  readOut() {
    return this._readRing(OFF_OUT);
  }

  /** Append one TLV to the in-ring (host → game). @returns false if full. */
  writeIn(type, payload) {
    return this._writeRing(OFF_IN, type, payload);
  }

  /** Free bytes in the in-ring right now. */
  inSpace() {
    const head = this._u16(OFF_IN), tail = this._u16(OFF_IN + 2);
    return RING_SIZE - 1 - ((head - tail + RING_SIZE) % RING_SIZE);
  }

  _readRing(ringOff) {
    const bufOff = ringOff + 4;
    let head = this._u16(ringOff);
    let tail = this._u16(ringOff + 2);
    const records = [];
    while (tail !== head) {
      const type = this.bytes[this.base + bufOff + tail];
      const len = this.bytes[this.base + bufOff + ((tail + 1) % RING_SIZE)];
      const payload = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        payload[i] = this.bytes[this.base + bufOff + ((tail + 2 + i) % RING_SIZE)];
      }
      tail = (tail + 2 + len) % RING_SIZE;
      records.push({ type, payload });
    }
    this._setU16(ringOff + 2, tail);
    return records;
  }

  _writeRing(ringOff, type, payload) {
    const bufOff = ringOff + 4;
    const head = this._u16(ringOff);
    const tail = this._u16(ringOff + 2);
    const free = RING_SIZE - 1 - ((head - tail + RING_SIZE) % RING_SIZE);
    const need = 2 + payload.length;
    if (need > free) return false;
    this.bytes[this.base + bufOff + head] = type;
    this.bytes[this.base + bufOff + ((head + 1) % RING_SIZE)] = payload.length;
    for (let i = 0; i < payload.length; i++) {
      this.bytes[this.base + bufOff + ((head + 2 + i) % RING_SIZE)] = payload[i];
    }
    this._setU16(ringOff, (head + need) % RING_SIZE);
    return true;
  }
}

// ---- payload codecs (both directions, shared by bridge and demo adapter) ----

const s16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const readS16 = (p, i) => {
  const v = p[i] | (p[i + 1] << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
};
const readU16 = (p, i) => p[i] | (p[i + 1] << 8);

export const enc = {
  presence: (g, n, x, y, f, s) => Uint8Array.from([g, n, ...s16(x), ...s16(y), f, s]),
  flagSet: (id) => Uint8Array.from([id & 0xff, id >> 8]),
  varSet: (id, v) => Uint8Array.from([id & 0xff, id >> 8, v & 0xff, v >> 8]),
  partySummary: (mons) =>
    Uint8Array.from([mons.length, ...mons.flatMap((m) => [m.sp & 0xff, m.sp >> 8, m.lv, m.hp ?? 100])]),
  request: (sub, arg) => Uint8Array.from([sub, arg]),
  battleEncounter: (kind, opp) => Uint8Array.from([1, kind, opp & 0xff, opp >> 8]),
  battleTurnInput: (turn, a, move, tgt, x) => Uint8Array.from([2, turn, a, move, tgt, x & 0xff, (x ?? 0) >> 8]),
  battleOutcome: (result) => Uint8Array.from([3, result]),
  hello: () => Uint8Array.from([PROTO_VERSION]),
  ghost: (slot, active, g, n, x, y, f, s) => Uint8Array.from([slot, active, g, n, ...s16(x), ...s16(y), f, s]),
  flagApply: (id) => Uint8Array.from([id & 0xff, id >> 8]),
  varApply: (id, v) => Uint8Array.from([id & 0xff, id >> 8, v & 0xff, v >> 8]),
  warp: (g, n, x, y) => Uint8Array.from([g, n, ...s16(x), ...s16(y)]),
  assign: (slot) => Uint8Array.from([slot]),
  partyFull: (monBytes) => Uint8Array.from([monBytes.length, ...monBytes.flat()]),
  battleParty: (wireMons) => Uint8Array.from([4, wireMons.length, ...wireMons.flat()]),
  battleStart: (seed, order, mode) =>
    Uint8Array.from([
      1,
      seed & 0xff, (seed >>> 8) & 0xff, (seed >>> 16) & 0xff, (seed >>> 24) & 0xff,
      order.length,
      order[0] ?? 0xff, order[1] ?? 0xff, order[2] ?? 0xff, order[3] ?? 0xff,
      mode === 'pvp' ? 1 : 0,
    ]),
  battleTurnRelay: (turn, from, a, move, tgt, x) =>
    Uint8Array.from([2, turn, from, a, move, tgt, x & 0xff, (x ?? 0) >> 8]),
  battleEnd: (result) => Uint8Array.from([3, result]),
  // Console/admin commands (§1.6). Field layout mirrors net_admin.c exactly.
  admin: (m) => {
    switch (m.sub) {
      case 'give_item': return Uint8Array.from([1, m.item & 0xff, m.item >> 8, m.qty & 0xff, m.qty >> 8]);
      case 'take_item': return Uint8Array.from([2, m.item & 0xff, m.item >> 8, m.qty & 0xff, m.qty >> 8]);
      case 'give_mon': return Uint8Array.from([3, m.species & 0xff, m.species >> 8, m.level]);
      case 'set_level': return Uint8Array.from([4, m.slot, m.level]);
      case 'give_xp':
        return Uint8Array.from([5, m.slot, m.xp & 0xff, (m.xp >>> 8) & 0xff, (m.xp >>> 16) & 0xff, (m.xp >>> 24) & 0xff]);
      case 'wild_battle': return Uint8Array.from([6, m.species & 0xff, m.species >> 8, m.level]);
      case 'reset_trainer': return Uint8Array.from([7, m.trainer & 0xff, m.trainer >> 8]);
      case 'set_name':
        // name = server-side charmap bytes, already EOS-padded to 8
        return Uint8Array.from([8, ...(m.name ?? []).slice(0, 8).map((b) => b & 0xff)]);
      default: return null;
    }
  },
};

export const dec = {
  presence: (p) => ({ g: p[0], n: p[1], x: readS16(p, 2), y: readS16(p, 4), f: p[6], s: p[7] }),
  flag: (p) => ({ id: readU16(p, 0) }),
  var: (p) => ({ id: readU16(p, 0), v: readU16(p, 2) }),
  partySummary: (p) => {
    const mons = [];
    for (let i = 0; i < p[0]; i++) {
      const o = 1 + i * 4;
      mons.push({ sp: readU16(p, o), lv: p[o + 2], hp: p[o + 3] });
    }
    return mons;
  },
  request: (p) => ({ sub: p[0], arg: p[1] }),
  partyFull: (p) => {
    const mons = [];
    for (let i = 0; i < p[0]; i++) {
      const b = [...p.slice(1 + i * MON_WIRE_SIZE, 1 + (i + 1) * MON_WIRE_SIZE)];
      mons.push({ lv: b[20], b });
    }
    return mons;
  },
  battleEvent: (p) => {
    switch (p[0]) {
      case 1: return { sub: 'encounter', kind: p[1], opp: readU16(p, 2) };
      case 2: return { sub: 'input', turn: p[1], a: p[2], move: p[3], tgt: p[4], x: readU16(p, 5) };
      case 3: return { sub: 'outcome', result: p[1] };
      default: return { sub: 'unknown' };
    }
  },
  ghost: (p) => ({ slot: p[0], active: p[1], g: p[2], n: p[3], x: readS16(p, 4), y: readS16(p, 6), f: p[8], s: p[9] }),
  warp: (p) => ({ g: p[0], n: p[1], x: readS16(p, 2), y: readS16(p, 4) }),
  assign: (p) => ({ slot: p[0] }),
  battleCmd: (p) => {
    switch (p[0]) {
      case 1: {
        const seed = (p[1] | (p[2] << 8) | (p[3] << 16) | (p[4] << 24)) >>> 0;
        const order = [...p.slice(6, 6 + p[5])];
        return { sub: 'start', seed, order, mode: p[10] === 1 ? 'pvp' : 'coop' };
      }
      case 2: return { sub: 'input', turn: p[1], from: p[2], a: p[3], move: p[4], tgt: p[5], x: readU16(p, 6) };
      case 3: return { sub: 'end', result: p[1] };
      case 4: {
        const mons = [];
        for (let i = 0; i < p[1]; i++) {
          mons.push([...p.slice(2 + i * MON_WIRE_SIZE, 2 + (i + 1) * MON_WIRE_SIZE)]);
        }
        return { sub: 'party', mons };
      }
      default: return { sub: 'unknown' };
    }
  },
  admin: (p) => {
    switch (p[0]) {
      case 1: return { sub: 'give_item', item: readU16(p, 1), qty: readU16(p, 3) };
      case 2: return { sub: 'take_item', item: readU16(p, 1), qty: readU16(p, 3) };
      case 3: return { sub: 'give_mon', species: readU16(p, 1), level: p[3] };
      case 4: return { sub: 'set_level', slot: p[1], level: p[2] };
      case 5: return { sub: 'give_xp', slot: p[1], xp: (p[2] | (p[3] << 8) | (p[4] << 16) | (p[5] << 24)) >>> 0 };
      case 6: return { sub: 'wild_battle', species: readU16(p, 1), level: p[3] };
      case 7: return { sub: 'reset_trainer', trainer: readU16(p, 1) };
      case 8: return { sub: 'set_name', name: [...p.slice(1)] };
      default: return { sub: 'unknown' };
    }
  },
};
