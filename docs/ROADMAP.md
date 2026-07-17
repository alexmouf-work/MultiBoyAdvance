# Roadmap

Phases ship in order; each has a hard acceptance test. "Done" always means the
acceptance test passes.

## Phase 0 — Foundations ✅ (this repo, built in-session)

- Monorepo layout; protocol spec; authoritative server with tests; web client
  with demo mode; ROM overlay scaffolding; mGBA Lua bridge; e2e demo-mode test.
- **Accept**: `npm test` green in `server/`; e2e demo test shows two browsers
  seeing each other's ghosts and a battle join round-trip — no ROM required.

## Phase 1 — Overworld presence in the real game

- Build the netcode ROM (`rom/setup.sh` on WSL2), integrate `net_overworld.c`
  hooks, render ghosts as object events.
- **Accept**: two browsers (or two desktop mGBAs) on the LAN, real ROM: players
  see each other walk in the same map, despawn on map change.

## Phase 2 — Shared story

- Route story-flag writes through the mailbox; server flag store already exists.
- **Accept**: player A beats a story trainer/boss; player B's world reflects it
  (same flag set) after reconnect and live; state survives server restart.

## Phase 3 — Co-op battles (the heart)

- Join window UI on encounter; server merges parties (top `ceil(6/N)` by level),
  distributes seed + turn order; ROM injects merged party, drives turns from
  relayed inputs; bag filtered to the acting player; win → return warp,
  loss → shared Pokémon Center whiteout.
- Already done ahead of schedule: encounter join-window hooks, shared-seed
  RNG at START, full-party wire transfer (PROTOCOL §1.5), server-side wire
  merge, and merged-party injection/restore around the session. Remaining:
  feeding relayed TURN_INPUTs into the battle controllers, in-ROM join UI,
  and bag scoping.
- **Accept**: scripted 2-player co-op battle with a merged 3+3 party where both
  screens stay identical turn-by-turn, and both outcomes (win/loss placement)
  behave as specified.

## Phase 4 — Teleport & PvP

- `tp` warps to a player's live position; challenge/accept starts a lockstep
  PvP battle with real parties.
- **Accept**: A teleports to B; A↔B PvP battle resolves identically on both screens.

## Phase 5 — Internet & hardening

- WSS/TLS or tunnel (Cloudflare Tunnel), lobby auth, reconnection polish,
  server-side battle outcome validation, anti-desync telemetry, world backups.
- **Accept**: a player outside the LAN completes Phases 1–4 flows through the
  exposed endpoint.

## Deliberate non-goals (for now)

- More than 8 concurrent players; matchmaking; multiple simultaneous worlds
  (the server has one world; run two servers for two worlds).
- Cartridge-accurate battle validation server-side (Showdown is not
  bug-for-bug Gen-3; see RESEARCH.md — the ROM engine is the authority).
- ~~Trading UI~~ — now planned in detail: see `docs/plans/TRADING.md`. Team/co-op
  battles (completing Phase 3 with the owner's turn-alternation + team-builder GUI)
  are planned in `docs/plans/TEAM-BATTLES.md`.
