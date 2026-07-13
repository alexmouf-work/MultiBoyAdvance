import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldState } from '../src/world/state.js';

test('flags and vars are monotonic / change-detecting', () => {
  const s = new WorldState(null);
  assert.equal(s.setFlag(0x100), true);
  assert.equal(s.setFlag(0x100), false); // already set: no broadcast
  assert.equal(s.setVar(0x4001, 5), true);
  assert.equal(s.setVar(0x4001, 5), false); // same value
  assert.equal(s.setVar(0x4001, 6), true);
});

test('snapshot round-trips through disk', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mba-')), 'world.json');
  const a = new WorldState(file);
  a.setFlag(0x123);
  a.setFlag(0x456);
  a.setVar(0x4000, 42);
  a.close(); // forces saveNow

  const b = new WorldState(file);
  assert.equal(b.flags.has(0x123), true);
  assert.equal(b.flags.has(0x456), true);
  assert.equal(b.vars.get(0x4000), 42);
  b.close();
});
