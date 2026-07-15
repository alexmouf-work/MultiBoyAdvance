// Sanity checks over the generated Hoenn map-name table (web/js/data/).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapName, MAP_NAMES } from '../js/data/map-names.js';

test('map names: known Hoenn maps resolve to friendly names', () => {
  assert.equal(mapName(0, 9), 'Littleroot Town');
  assert.equal(mapName(0, 16), 'Route 101');
  assert.equal(mapName(0, 8), 'Ever Grande City');
});

test('map names: unknown or missing coordinates degrade gracefully', () => {
  assert.equal(mapName(200, 200), 'map 200.200');
  assert.equal(mapName(undefined, 3), '');
  assert.equal(mapName(0, null), '');
});

test('map names: table covers the full overworld group', () => {
  // group 0 is towns + routes; pokeemerald ships 34 map groups
  assert.ok(Object.keys(MAP_NAMES[0]).length >= 50);
  assert.ok(Object.keys(MAP_NAMES).length >= 30);
});
