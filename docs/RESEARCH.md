# Field research (2026-07): what exists, what we reuse

Summary of a multi-source research pass over the state of the art for
browser-based, shared-world GBA Pokémon multiplayer. Drives the adopt-vs-build
decisions in [ARCHITECTURE.md](ARCHITECTURE.md).

## Adopt-vs-build matrix

| Component | Verdict | Choice | Why |
|---|---|---|---|
| Browser emulator | **Adopt** | [`@thenick775/mgba-wasm`](https://www.npmjs.com/package/@thenick775/mgba-wasm) (npm, MPL-2.0) | Maintained mGBA WASM core behind gbajs3; per-frame JS callbacks, input injection, ROM loading; raw heap exposed for memory access. Upstream mGBA has no WASM build (issue #1296 still open, slated 0.12) |
| Memory bridge | **Build (small)** | magic-scan EWRAM mailbox | No official memory API in mgba-wasm; heap scan for magic bytes is robust and validated by the patterns below |
| Desktop runtime | **Adopt** | stock mGBA + Lua scripting | Official scripting API: per-frame callback, full memory r/w, built-in TCP sockets, key injection ([docs](https://mgba.io/docs/scripting.html)) |
| ROM base | **Adopt** | [`pret/pokeemerald`](https://github.com/pret/pokeemerald) | Modern `arm-none-eabi-gcc` builds work; vanilla engine is closest to the Ruby-era experience; expansion's Gen-9 engine adds churn we don't need |
| ROM netcode | **Build, guided** | our `net_*.c` overlay | Mine [KittyPBoxx/pokeemerald-net-demo](https://github.com/KittyPBoxx/pokeemerald-net-demo) (MIT: in-ROM net functions + Node server) for patterns |
| Server framework | **Build (small)** | plain [`ws`](https://github.com/websockets/ws) + `node:net` | Colyseus's server-owned-state schema fits badly when canonical state lives in each ROM; at 4–8 players a room layer is ~200 lines |
| Battle authority | **Build in-ROM** | deterministic lockstep | Pokémon Showdown is Smogon-accurate, not cartridge bug-for-bug for Gen 3 (the [pkmn/engine](https://github.com/pkmn/engine) project exists because of this and doesn't cover Gen 3 yet) |

## Prior art worth knowing

- **Pokémon Quetzal** (TenmaRH) — pokeemerald-based hack, formerly literally
  "Pokémon Emerald Multiplayer": up to 4 players, shared overworld, co-op
  battles, local+online play under mGBA. **Closed source** (only a vanilla
  pokeemerald fork is public) — proof of feasibility and a UX reference, not a
  module.
- **xp-online** (emilyploszaj) — shared-overworld Pokémon multiplayer implemented
  *entirely* as an mGBA Lua script (per-frame RAM reads, ghost sprites, server
  sync). Gen-2 target and unlicensed, but it validates the Lua-bridge pattern
  end-to-end, including its 1-frame ghost jitter limits.
- **Archipelago `_bizhawk` connector** (MIT) — production-proven Lua-in-emulator
  memory bridge: batched same-frame reads/writes over a socket, guarded writes,
  used against Pokémon Emerald at multiworld scale. Its request/response and
  guard patterns informed the mailbox design.
- **pokeemerald-net-demo** (KittyPBoxx, MIT) — modified pokeemerald with reusable
  in-ROM network functions + Node TCP server (trades, downloadable battles,
  marts, gift eggs) over JOYBUS→Wii transport. ROM-side serialization patterns
  are directly minable; transport is not ours.
- **tripplyons/pokeemerald-wasm** — pokeemerald recompiled *directly to WASM*
  (no emulator); JS owns game memory as a typed array and calls `WasmRunFrame()`.
  Architecturally elegant (would collapse emulator+bridge into one layer) but
  young, currently audio-less, unlicensed. Revisit as a future runtime once it
  matures; our bridge/server layers would carry over unchanged.
- **gpSP + RetroArch ≥1.17 Netpacket RFU** — GBA *wireless adapter* netplay works
  today with unmodified Emerald ("works well" tier): Union Room battles/trades
  with zero code. No shared overworld, so it's a stopgap/benchmark, not the
  architecture.
- **mGBA netplay status** — mainline mGBA has neither WASM nor networked link
  cable (issues #1296, #2379 both open, milestoned 0.12). Anything "just use
  mGBA netplay" is not currently real.
- **EmulatorJS** — GBA via the mgba libretro core, but exposes no guest-memory
  JS API; ruled out. **endrift/gbajs** — archived 2018, no link cable; ruled
  out. **gbajs2** — alive but pure-JS with "acceptable" performance; ruled out
  for Emerald.
- **pokeemerald-expansion (rh-hideout)** — very active (1.16.x, 2026), agbcc
  fully removed, `TOOLCHAIN` override for plain `arm-none-eabi-gcc`, WSL2
  strongly recommended on Windows. We stay on vanilla pret for authenticity,
  but its toolchain conclusions apply to us.
- **Pokémon Showdown / @pkmn/sim** (MIT) — embeddable Node `BattleStream` with
  seedable RNG and gen3 formats; kept in reserve as an *approximate* server-side
  sanity checker, not an authority.

## Key risks carried forward

1. **mgba-wasm heap scan** — the mailbox scan must find EWRAM inside a ≥256 MB
   Emscripten heap; mitigated by scanning once, caching, and re-verifying magic
   per frame. If the fork ever exports a proper memory API, swap the scan out.
2. **Ghost rendering in pokeemerald** — spawning/moving up to 7 extra object
   events on arbitrary maps is the hackiest ROM work (Quetzal proves it's
   possible; xp-online shows the jitter budget). Phase 1's main effort.
3. **Battle determinism** — vanilla Emerald RNG is a simple LCG we fully control
   at battle start, but every divergence source (Battle Palace randomness, item
   activation order) must route through the shared seed. Phase 3's main effort.
4. **COOP/COEP** — the threaded WASM core requires cross-origin isolation;
   embedding the client in other pages later will inherit that constraint.
