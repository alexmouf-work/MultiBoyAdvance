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

test('trainer records: created once per name, position remembered across restarts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mba-')), 'world.json');
  const a = new WorldState(file);
  const t0 = 1000;
  a.touchUser('Alex', t0);
  a.touchUser('alex', t0 + 50); // case-insensitive: same trainer
  assert.equal(a.users.size, 1);
  assert.equal(a.users.get('alex').createdAt, t0);
  assert.equal(a.users.get('alex').lastSeenAt, t0 + 50);

  a.updateUserPos('ALEX', 0, 18, 12, 7, t0 + 99);
  a.updateUserPos('nobody', 1, 1, 1, 1); // unknown name: ignored
  a.close();

  const b = new WorldState(file);
  const u = b.users.get('alex');
  assert.equal(u.name, 'Alex'); // display name is the first spelling used
  assert.deepEqual([u.g, u.n, u.x, u.y], [0, 18, 12, 7]);
  assert.equal(u.lastSeenAt, t0 + 99);
  assert.equal(b.users.size, 1);
  b.close();
});
