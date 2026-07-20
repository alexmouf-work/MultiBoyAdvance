// Browser-local recovery.
//
// The emulator persists its files in an IndexedDB "filesystem"; if that gets
// corrupted it garbles every later boot on this browser, and the player can get
// stuck before they ever reach the in-game console that would fix it. Wiping
// the local caches clears it — and because every save also lives on the server,
// nothing of value is lost.
//
// Shared on purpose by the in-game console (js/ui/ui.js) and the pre-login
// console on the start screen (js/main.js), so a stuck player can recover from
// the start screen without having to boot the game first.
export async function wipeLocalData({ includePrefs = false } = {}) {
  if (includePrefs) {
    try { localStorage.clear(); } catch { /* best effort */ }
  }
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    await Promise.all(dbs.map((db) => new Promise((done) => {
      const req = indexedDB.deleteDatabase(db.name);
      req.onsuccess = req.onerror = req.onblocked = done;
    })));
  } catch { /* best effort */ }
  // Also drop the cached ROM build so the next boot re-downloads it fresh.
  try {
    if ('caches' in window) {
      for (const k of await caches.keys()) await caches.delete(k);
    }
  } catch { /* best effort */ }
  location.reload();
}
