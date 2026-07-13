// Adapter over @thenick775/mgba-wasm (vendored to /vendor/mgba.js by
// `npm install` in web/). Requires the page to be cross-origin isolated —
// the server sets COOP/COEP for exactly this reason.

export class MgbaAdapter {
  kind = 'mgba';
  #module = null;
  #frameCbs = [];

  async init(canvas) {
    if (!crossOriginIsolated) {
      throw new Error('page is not cross-origin isolated; the mGBA core cannot start');
    }
    const { default: mGBA } = await import('/vendor/mgba.js');
    this.#module = await mGBA({ canvas });
    await this.#module.FSInit?.();
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
}
