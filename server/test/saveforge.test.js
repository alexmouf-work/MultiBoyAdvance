// Unit tests for the .sav forge (src/saveforge.js) — the freeze-free save
// path. Layout truths mirrored from pokeemerald src/save.c.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forgeSave, readSector, sectorChecksum,
  SECTOR_SIZE, SECTOR_DATA_SIZE, NUM_SECTORS_PER_SLOT, SECTOR_SIGNATURE, FLASH_SIZE,
} from '../src/saveforge.js';

// Realistic sizes (vanilla Emerald): sb2 3884, sb1 15752, storage 33744.
function makeBlocks(fill = 1) {
  const mk = (len, seed) => Uint8Array.from({ length: len }, (_, i) => (i * seed + fill) & 0xff);
  return { sb2: mk(3884, 3), sb1: mk(15752, 5), sto: mk(33744, 7) };
}

test('checksum: folded u32 word sum, exactly like save.c', () => {
  // words: 0x04030201 + 0x08070605 = 0x0C0A0806 -> (0x0C0A + 0x0806) = 0x1410
  assert.equal(sectorChecksum(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), 0x1410);
  assert.equal(sectorChecksum(new Uint8Array(0)), 0);
});

test('forge: sector placement, rotation, counters, checksums', () => {
  const blocks = makeBlocks();
  const counter = 6; // even -> new counter 7 (odd) -> slot 2 (sectors 14-27)
  const lastSector = 3; // -> rotation offset 4
  const image = forgeSave(blocks, counter, lastSector);
  assert.equal(image.length, FLASH_SIZE);

  const seen = new Map();
  for (let phys = NUM_SECTORS_PER_SLOT; phys < 2 * NUM_SECTORS_PER_SLOT; phys++) {
    const s = readSector(image, phys);
    assert.equal(s.signature, SECTOR_SIGNATURE);
    assert.equal(s.counter, 7);
    seen.set(s.id, phys);
  }
  // every logical sector exactly once, at the rotated physical position
  for (let id = 0; id < NUM_SECTORS_PER_SLOT; id++) {
    assert.equal(seen.get(id), ((id + 4) % NUM_SECTORS_PER_SLOT) + NUM_SECTORS_PER_SLOT, `sector ${id}`);
  }

  // data + checksum: SaveBlock2 is logical sector 0; SaveBlock1 spans 1-4
  // with a partial final chunk; storage spans 5-13.
  const check = (id, src, chunk) => {
    const s = readSector(image, seen.get(id));
    const expected = src.subarray(chunk * SECTOR_DATA_SIZE, (chunk + 1) * SECTOR_DATA_SIZE);
    assert.deepEqual(s.data.subarray(0, expected.length), expected, `sector ${id} data`);
    assert.equal(s.checksum, sectorChecksum(expected), `sector ${id} checksum`);
    // padding beyond the chunk is zeroed
    assert.ok(s.data.subarray(expected.length).every((b) => b === 0), `sector ${id} padding`);
  };
  check(0, blocks.sb2, 0);
  for (let k = 0; k < 4; k++) check(1 + k, blocks.sb1, k);
  for (let k = 0; k < 9; k++) check(5 + k, blocks.sto, k);

  // the other slot stays factory-blank (no base image given)
  assert.ok(image.subarray(0, NUM_SECTORS_PER_SLOT * SECTOR_SIZE).every((b) => b === 0xff));
});

test('forge: preserves the base image outside the written slot', () => {
  const blocks = makeBlocks();
  const base = new Uint8Array(FLASH_SIZE).fill(0xaa); // pretend old data everywhere
  const image = forgeSave(blocks, 7, 0, base); // new counter 8 (even) -> slot 1 (0-13)

  // slot 2 and the special sectors (HOF etc.) are untouched
  assert.ok(image.subarray(14 * SECTOR_SIZE).every((b) => b === 0xaa));
  // slot 1 got the new save
  assert.equal(readSector(image, 1).counter, 8); // rotation offset 1: id 0 -> phys 1
});

test('forge: successive forges without a real save stay on one slot, fresher each time', () => {
  const a = forgeSave(makeBlocks(1), 4, 2);
  const b = forgeSave(makeBlocks(9), 4, 2, a); // same counters -> same slot, new data
  const slotStart = NUM_SECTORS_PER_SLOT; // counter 5 -> odd -> slot 2
  const sA = readSector(a, slotStart);
  const sB = readSector(b, slotStart);
  assert.equal(sA.counter, sB.counter);
  assert.notDeepEqual(sA.data, sB.data, 'newer snapshot replaced the old one');
});

test('forge: rejects malformed blocks', () => {
  const blocks = makeBlocks();
  assert.throws(() => forgeSave({ ...blocks, sb2: new Uint8Array(SECTOR_DATA_SIZE + 1) }, 0, 0));
  assert.throws(() => forgeSave({ ...blocks, sto: new Uint8Array(0) }, 0, 0));
  assert.throws(() => forgeSave({ sb2: blocks.sb2, sb1: blocks.sb1 }, 0, 0));
});
