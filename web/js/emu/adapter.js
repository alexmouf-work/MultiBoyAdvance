// EmulatorAdapter — the contract both runtimes implement.
//
// interface EmulatorAdapter {
//   readonly kind: 'mgba' | 'demo';
//   async init(canvas: HTMLCanvasElement): Promise<void>;
//   async loadROM(file: File): Promise<void>;      // demo: ignored
//   onFrameEnd(cb: () => void): void;              // fires once per emulated frame
//   memory(): Uint8Array;                          // region containing the mailbox
//   memoryBase(): number;                          // scan start hint within memory()
// }
//
// The bridge only ever touches memory() + onFrameEnd(); everything else is
// runtime-private. See docs/ARCHITECTURE.md.

export function assertAdapter(a) {
  for (const m of ['init', 'loadROM', 'onFrameEnd', 'memory', 'memoryBase']) {
    if (typeof a[m] !== 'function') throw new Error(`adapter missing ${m}()`);
  }
  return a;
}
