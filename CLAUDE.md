# CLAUDE.md — project charter for AI sessions

## Git workflow (standing instruction from the repo owner)

- **Always work from `main`.** Check out `main` at session start, pull from
  `origin main` before starting work, commit to `main`, and push to
  `origin main`. Do not create or use side branches unless the owner asks.
- Commit each finished unit of work with a descriptive message and push
  promptly; never leave the tree dirty at the end of a turn.

## What this project is

Shared-world multiplayer Pokémon (Gen 3, pokeemerald-based) played in the
browser or desktop mGBA, hosted from the owner's Windows 11 machine. Start
with `README.md`, then `docs/ARCHITECTURE.md`. `docs/PROTOCOL.md` is the
**normative spec** for the EWRAM mailbox and the JSON wire protocol — the four
implementations (C overlay, JS bridge, Lua bridge, Node server) must be kept
in lockstep with it and each other.

## Layout

- `server/` — authoritative Node server (`npm test` = 16 tests)
- `web/` — browser client; `npm install` vendors the mGBA-WASM core
  (`npm test` = codec tests)
- `e2e/` — Playwright suites: demo-mode multiplayer + real-ROM boot
- `rom/` — pokeemerald netcode overlay + `setup.sh` (clones the decomp,
  applies 6 verified hooks, builds `rom/build/mba.gba`); `rom/lua/` is the
  desktop-mGBA bridge; `rom/ci-syntax-check.sh` compile-checks the overlay
  without the decomp
- `emulator/` — vendored VBA-M (reference only; not part of the running stack)
- `docs/ROADMAP.md` — phase status and acceptance criteria

## Rules of the road

- Run the relevant test suite before every commit; CI
  (`.github/workflows/ci.yml`) runs them all on push.
- Never commit ROMs, saves, or the `rom/pokeemerald/` clone (gitignored).
- Protocol changes touch all four implementations + `docs/PROTOCOL.md` + tests,
  in the same commit.
- The `rom/ci-stubs/` headers mirror the pokeemerald contract; if the real
  build disagrees with a stub, fix the stub to match upstream.
