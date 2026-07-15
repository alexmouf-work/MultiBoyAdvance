// Authoritative shared world state (story flags + vars) and the trainer
// registry (returning players + their last position), with debounced
// JSON-file persistence. docs/PROTOCOL.md §2.3.

import fs from 'node:fs';
import path from 'node:path';

export class WorldState {
  /**
   * @param {string|null} file backing file; null = in-memory only (tests)
   * @param {number} saveDelayMs debounce for snapshot writes
   */
  constructor(file, saveDelayMs = 500) {
    this.file = file;
    this.saveDelayMs = saveDelayMs;
    this.flags = new Set();
    this.vars = new Map();
    /** @type {Map<string, {name, createdAt, lastSeenAt, g?, n?, x?, y?}>}
     *  key = lowercased name; one record per trainer, ever. */
    this.users = new Map();
    this._timer = null;
    if (file) this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const f of raw.flags ?? []) this.flags.add(f);
      for (const [id, v] of raw.vars ?? []) this.vars.set(id, v);
      for (const u of raw.users ?? []) if (u?.name) this.users.set(u.name.toLowerCase(), u);
    } catch {
      // first run or unreadable snapshot: start empty
    }
  }

  _scheduleSave() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, this.saveDelayMs);
    this._timer.unref?.();
  }

  saveNow() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot()));
    fs.renameSync(tmp, this.file);
  }

  snapshot() {
    return { flags: [...this.flags], vars: [...this.vars.entries()], users: [...this.users.values()] };
  }

  /** Find-or-create the persistent record for a trainer name; bumps lastSeenAt. */
  touchUser(name, now = Date.now()) {
    const key = name.toLowerCase();
    let u = this.users.get(key);
    if (!u) {
      u = { name, createdAt: now, lastSeenAt: now };
      this.users.set(key, u);
    }
    u.lastSeenAt = now;
    this._scheduleSave();
    return u;
  }

  /** Remember where a trainer is, so the join screen can show it later. */
  updateUserPos(name, g, n, x, y, now = Date.now()) {
    const u = this.users.get(name.toLowerCase());
    if (!u) return;
    Object.assign(u, { g, n, x, y, lastSeenAt: now });
    this._scheduleSave();
  }

  /** @returns {boolean} true if this is new information worth broadcasting */
  setFlag(id) {
    if (this.flags.has(id)) return false;
    this.flags.add(id);
    this._scheduleSave();
    return true;
  }

  /** @returns {boolean} true if the value changed */
  setVar(id, value) {
    if (this.vars.get(id) === value) return false;
    this.vars.set(id, value);
    this._scheduleSave();
    return true;
  }

  close() {
    if (this._timer) clearTimeout(this._timer);
    this.saveNow();
  }
}
