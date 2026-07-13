import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeParties } from '../src/battle/merge.js';

const mon = (sp, lv) => ({ sp, lv });

test('two players: top 3 from each by level', () => {
  const merged = mergeParties([
    { slot: 0, mons: [mon(1, 50), mon(2, 12), mon(3, 33), mon(4, 45), mon(5, 8), mon(6, 20)] },
    { slot: 1, mons: [mon(7, 60), mon(8, 55), mon(9, 5), mon(10, 40), mon(11, 39), mon(12, 2)] },
  ]);
  assert.equal(merged.length, 6);
  assert.deepEqual(
    merged.map((m) => m.sp),
    [7, 8, 1, 4, 10, 3], // 60,55,50,45,40,33
  );
  assert.deepEqual(new Set(merged.filter((m) => m.owner === 0).length ? [3] : []), new Set([3]));
});

test('three players: ceil(6/3)=2 each', () => {
  const merged = mergeParties([
    { slot: 0, mons: [mon(1, 10), mon(2, 20), mon(3, 30)] },
    { slot: 1, mons: [mon(4, 40), mon(5, 50)] },
    { slot: 2, mons: [mon(6, 60), mon(7, 70), mon(8, 80)] },
  ]);
  assert.equal(merged.length, 6);
  const byOwner = { 0: 0, 1: 0, 2: 0 };
  for (const m of merged) byOwner[m.owner]++;
  assert.deepEqual(byOwner, { 0: 2, 1: 2, 2: 2 });
  assert.equal(merged[0].sp, 8); // strongest first
});

test('level ties broken by earlier party position', () => {
  const merged = mergeParties([
    { slot: 0, mons: [mon(1, 50), mon(2, 50), mon(3, 50), mon(4, 50)] },
    { slot: 1, mons: [mon(5, 50)] },
  ]);
  // player 0 contributes its first three mons, in party order
  assert.deepEqual(merged.filter((m) => m.owner === 0).map((m) => m.idx), [0, 1, 2]);
});

test('short parties and solo participants degrade gracefully', () => {
  assert.deepEqual(mergeParties([]), []);
  const solo = mergeParties([{ slot: 3, mons: [mon(1, 5), mon(2, 9)] }]);
  assert.deepEqual(solo.map((m) => m.sp), [2, 1]);
  const uneven = mergeParties([
    { slot: 0, mons: [mon(1, 99)] },
    { slot: 1, mons: [mon(2, 1), mon(3, 2), mon(4, 3), mon(5, 4)] },
  ]);
  assert.equal(uneven.length, 4); // 1 + 3 available picks
});
