import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  httpPort: Number(process.env.MBA_HTTP_PORT ?? 8484),
  httpsPort: Number(process.env.MBA_HTTPS_PORT ?? 8443), // LAN play needs a secure context
  tcpPort: Number(process.env.MBA_TCP_PORT ?? 8485),
  host: process.env.MBA_HOST ?? '0.0.0.0',
  webRoot: process.env.MBA_WEB_ROOT ?? path.resolve(here, '../../web'),
  dataFile: process.env.MBA_DATA_FILE ?? path.resolve(here, '../data/world.json'),
  tlsDir: process.env.MBA_TLS_DIR ?? path.resolve(here, '../data'),
  maxPlayers: 8,
  protocolVersion: 1,
  battleJoinWindowMs: Number(process.env.MBA_JOIN_WINDOW_MS ?? 10_000),
  clientTimeoutMs: 60_000,
  // Flag/var ID ranges the server accepts as shared world state.
  // pokeemerald: script+system+badge flags and defeated-trainer flags all fall
  // inside 0x020..0x97F; story vars are 0x4000..0x40FF. Temporary/daily IDs
  // stay local on purpose.
  syncedFlagRanges: [[0x020, 0x97f]],
  syncedVarRanges: [[0x4000, 0x40ff]],
};
