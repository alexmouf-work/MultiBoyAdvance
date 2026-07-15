// Adapter over @thenick775/mgba-wasm (vendored to /vendor/mgba.js by
// `npm install` in web/). Requires the page to be cross-origin isolated —
// the server sets COOP/COEP for exactly this reason.

export class MgbaAdapter {
  kind = 'mgba';
  #module = null;
  #frameCbs = [];

  async init(canvas) {
    if (!crossOriginIsolated) {
      throw new Error(
        'this page is not a secure context, so the threaded mGBA core cannot start. ' +
        'Open the client via the https:// address (port 8443; accept the one-time ' +
        'certificate warning) — or via http://localhost:8484 on the host machine itself.',
      );
    }
    const { default: mGBA } = await import('/vendor/mgba.js');
    this.#module = await mGBA({ canvas });
    await this.#module.FSInit?.();
  }

  // Core callbacks bind to the *current* core, which only exists once a game
  // is loaded — registering before loadGame attaches to nothing and the
  // bridge never receives a frame.
  #registerCoreCallbacks() {
    this.#module.addCoreCallbacks({
      videoFrameEndedCallback: () => {
        for (const cb of this.#frameCbs) cb();
      },
    });
  }

  /** @param {File} file a .gba ROM picked by the player */
  async loadROM(file) {
    const mod = this.#module;
    await new Promise((resolve) => mod.uploadRom(file, resolve));
    const ok = mod.loadGame(`${mod.filePaths().gamePath}/${file.name}`);
    if (!ok) throw new Error(`mGBA failed to load ${file.name}`);
    this.#registerCoreCallbacks();
  }

  onFrameEnd(cb) {
    this.#frameCbs.push(cb);
  }

  /** Fresh heap view every call — Emscripten swaps buffers on memory growth. */
  memory() {
    return this.#module.HEAPU8;
  }

  memoryBase() {
    return 0; // mailbox location inside the heap is unknown; scan everything
  }

  // Touch controls (names: A, B, L, R, Start, Select, Up, Down, Left, Right)
  buttonDown(name) {
    this.#module?.buttonPress(name);
  }

  buttonUp(name) {
    this.#module?.buttonUnpress(name);
  }

  /** Shared world speed (1-4×). */
  setSpeed(x) {
    this.#module?.setFastForwardMultiplier(x);
  }

  // ---- save persistence ----

  /** Current .sav flash image, or null if none exists yet. */
  readSave() {
    return this.#module?.getSave() ?? null;
  }

  /** Stage a .sav before loadGame so the core boots with it (CONTINUE). */
  async writeSave(bytes, name = 'mba.sav') {
    const mod = this.#module;
    await new Promise((resolve) => mod.uploadSaveOrSaveState(new File([bytes], name), resolve));
  }

  /** Flush the emulator's file system to IndexedDB (the browser-side copy). */
  async persistFS() {
    await this.#module?.FSSync?.();
  }
}
