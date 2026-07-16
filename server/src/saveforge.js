// Forge a byte-exact pokeemerald .sav from live save-block snapshots — the
// freeze-free save path. The game never runs its ~2s flash ceremony for
// these; the bridge snapshots SaveBlock2/SaveBlock1/PokemonStorage between
// frames (guaranteed consistent) and this module packs them exactly the way
// src/save.c's WriteSaveSectorOrSlot + HandleWriteSector would.
//
// Normative reference: pokeemerald src/save.c + include/save.h. If upstream
// changes the sector format, this file must follow (the repro harness's
// forge → reload → CONTINUE cycle is the compatibility test).

export const SECTOR_SIZE = 0x1000;
export const SECTOR_DATA_SIZE = 3968;
export const NUM_SECTORS_PER_SLOT = 14;
export const NUM_SAVE_SLOTS = 2;
export const SECTOR_SIGNATURE = 0x8012025;
export const FLASH_SIZE = 128 * 1024; // 32 sectors: 2 slots + HOF/TrainerHill/RecordedBattle

// Footer offsets inside a sector (struct SaveSector).
const OFF_ID = 0xff4;
const OFF_CHECKSUM = 0xff6;
const OFF_SIGNATURE = 0xff8;
const OFF_COUNTER = 0xffc;

// Sectors per block, fixed by the game (save.h SECTOR_ID_*).
const CHUNKS = { sb2: 1, sb1: 4, sto: 9 };

/** save.c CalculateChecksum: u32 word sum over `size` bytes, folded to u16. */
export function sectorChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    sum = (sum + ((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0)) >>> 0;
  }
  return ((sum >>> 16) + (sum & 0xffff)) & 0xffff;
}

/**
 * Build the full flash image a real SAVE_NORMAL would have produced.
 *
 * @param {{sb2: Uint8Array, sb1: Uint8Array, sto: Uint8Array}} blocks
 *   Fresh save-block bytes (the ROM ran CopyPartyAndObjectsToSave first).
 * @param {number} counter the game's CURRENT gSaveCounter (pre-increment)
 * @param {number} lastWrittenSector the game's CURRENT gLastWrittenSector
 * @param {Uint8Array|null} base previous flash image; its other slot and the
 *   Hall of Fame / special sectors are preserved. null = fresh 0xFF image.
 * @returns {Uint8Array} 128 KB .sav
 */
export function forgeSave(blocks, counter, lastWrittenSector, base = null) {
  for (const [key, chunks] of Object.entries(CHUNKS)) {
    const b = blocks[key];
    if (!(b instanceof Uint8Array) || b.length === 0 || b.length > chunks * SECTOR_DATA_SIZE) {
      throw new Error(`bad ${key} block (${b?.length ?? 'missing'} bytes)`);
    }
  }

  const out = new Uint8Array(FLASH_SIZE).fill(0xff);
  if (base && base.length === FLASH_SIZE) out.set(base);

  // Exactly WriteSaveSectorOrSlot(FULL_SAVE_SLOT): bump rotation + counter,
  // then place logical sectors 0..13 into the (new) alternate slot.
  const newLast = (lastWrittenSector + 1) % NUM_SECTORS_PER_SLOT;
  const newCounter = (counter + 1) >>> 0;
  const slotBase = NUM_SECTORS_PER_SLOT * (newCounter % NUM_SAVE_SLOTS);

  const layout = [
    { src: blocks.sb2, chunk: 0 }, // sector 0: SaveBlock2
    ...Array.from({ length: CHUNKS.sb1 }, (_, k) => ({ src: blocks.sb1, chunk: k })), // 1-4
    ...Array.from({ length: CHUNKS.sto }, (_, k) => ({ src: blocks.sto, chunk: k })), // 5-13
  ];

  for (let sectorId = 0; sectorId < NUM_SECTORS_PER_SLOT; sectorId++) {
    const { src, chunk } = layout[sectorId];
    const off = chunk * SECTOR_DATA_SIZE;
    const size = Math.max(0, Math.min(src.length - off, SECTOR_DATA_SIZE));
    const data = src.subarray(off, off + size);

    const phys = ((sectorId + newLast) % NUM_SECTORS_PER_SLOT) + slotBase;
    const sec = out.subarray(phys * SECTOR_SIZE, (phys + 1) * SECTOR_SIZE);
    sec.fill(0); // HandleWriteSector zeroes the whole sector first
    sec.set(data, 0);

    const dv = new DataView(out.buffer, out.byteOffset + phys * SECTOR_SIZE, SECTOR_SIZE);
    dv.setUint16(OFF_ID, sectorId, true);
    dv.setUint16(OFF_CHECKSUM, sectorChecksum(data), true);
    dv.setUint32(OFF_SIGNATURE, SECTOR_SIGNATURE, true);
    dv.setUint32(OFF_COUNTER, newCounter, true);
  }
  return out;
}

/** Parse one sector's footer (for tests and sanity checks). */
export function readSector(image, phys) {
  const dv = new DataView(image.buffer, image.byteOffset + phys * SECTOR_SIZE, SECTOR_SIZE);
  return {
    id: dv.getUint16(OFF_ID, true),
    checksum: dv.getUint16(OFF_CHECKSUM, true),
    signature: dv.getUint32(OFF_SIGNATURE, true),
    counter: dv.getUint32(OFF_COUNTER, true),
    data: image.subarray(phys * SECTOR_SIZE, phys * SECTOR_SIZE + SECTOR_DATA_SIZE),
  };
}
