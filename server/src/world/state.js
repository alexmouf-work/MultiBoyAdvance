// Authoritative shared world state (story flags + vars) with debounced
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
    this._timer = null;
    if (file) this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const f of raw.flags ?? []) this.flags.add(f);
      for (const [id, v] of raw.vars ?? []) this.vars.set(id, v);
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
    return { flags: [...this.flags], vars: [...this.vars.entries()] };
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
