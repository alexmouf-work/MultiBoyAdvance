// Copies the mGBA WASM core out of node_modules into web/vendor/ so the client
// stays a plain static site (no bundler). Runs automatically on `npm install`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, 'node_modules', '@thenick775', 'mgba-wasm', 'dist');
const dst = path.join(here, 'vendor');

if (!fs.existsSync(src)) {
  console.error('[vendor] @thenick775/mgba-wasm not installed; run npm install in web/');
  process.exit(1);
}
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
}
console.log(`[vendor] copied ${fs.readdirSync(dst).length} files to web/vendor/`);
