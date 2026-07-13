# Architecture

## The problem shape

A GBA ROM is a sealed single-player world: one save file, one player object, one
controller, no I/O beyond buttons and the link port. Every multiplayer feature we
want — visible co-players, one shared story, merged co-op battles, teleports,
PvP — is *game logic*, so it must live in the game. But the game can't talk to a
network. So the design splits three ways:

```
┌───────────────────────────┐     ┌──────────────────────────┐     ┌─────────────────────────┐
│ GAME (rom/)               │     │ BRIDGE                   │     │ SERVER (server/)        │
│ modified pokeemerald, C   │     │ web/js/bridge (browser)  │     │ Node, authoritative     │
│ • writes presence, flags, │◀───▶│ rom/lua (desktop mGBA)   │◀───▶│ • rooms per map         │
│   battle events to a      │ RAM │ • finds mailbox in EWRAM │ net │ • world flag store      │
│   mailbox struct in EWRAM │     │ • per-frame read/write   │     │ • battle sessions       │
│ • applies ghosts, warps,  │     │ • translates TLV ⇄ JSON  │     │ • teleport/PvP broker   │
│   flag/battle commands    │     │                          │     │ • persistence           │
└───────────────────────────┘     └──────────────────────────┘     └─────────────────────────┘
```

The **mailbox** (see [PROTOCOL.md](PROTOCOL.md)) is the only contract between game
and bridge; the **wire protocol** is the only contract between bridge and server.
Consequences:

- The game compiles once and runs identically under any bridge.
- Bridges are dumb translators — new runtimes are cheap.
- The server never parses GBA memory; it speaks only JSON.

## Runtimes

Two supported bridge runtimes, one browser and one desktop, chosen from the
field research (see [RESEARCH.md](RESEARCH.md)):

1. **Browser**: `@thenick775/mgba-wasm` (the maintained mGBA WASM core behind
   gbajs3, MPL-2.0, on npm). The web client registers a
   `videoFrameEndedCallback`, locates the mailbox by scanning the Emscripten
   heap for the magic bytes, and exchanges TLVs each frame. Requires
   cross-origin isolation (COOP/COEP), which our server sets on all responses.
2. **Desktop**: stock mGBA (0.10+/dev) running `rom/lua/mba-bridge.lua` — same
   mailbox scan via the scripting memory API, same per-frame callback, JSON
   lines over mGBA's built-in TCP sockets. This is the proven, low-latency
   LAN-party path (pattern validated by Archipelago's BizHawk connector and the
   xp-online project).

The web client also ships a **demo adapter**: a tiny simulated "game" (movable
avatar + real mailbox buffer in JS) that exercises bridge, wire, server, ghosts,
flags, and the battle flow with no ROM and no emulator. It exists so the whole
multiplayer stack is testable end-to-end in CI and before the ROM is built.

## Sync models (why each feature syncs the way it does)

| Feature | Model | Rationale |
|---|---|---|
| Overworld presence | **Soft sync**: each client owns its avatar; others render as ghost object-events | Latency-tolerant; a late ghost update is cosmetic, never corrupting |
| Story flags/vars | **Server-authoritative log**: report local set → server records → broadcasts to all (idempotent apply) | "Story progresses once" is exactly a shared monotonic set |
| Co-op battles | **Scoped lockstep**: server distributes merged party + RNG seed + turn order; every participant's ROM simulates the identical battle from relayed turn inputs | The Gen-3 battle engine is deterministic given party+seed+inputs; lockstep only inside battles avoids whole-game determinism |
| Teleport / PvP | **Server-brokered warps** into the same map, then normal presence / a lockstep battle | Reuses the two mechanisms above |

## Failure behavior

- Bridge disconnected → game keeps playing single-player; `hostAttached` drops,
  ghosts despawn on the server after timeout.
- Server restart → world flags/vars reload from `server/data/world.json`
  (debounced snapshot); clients reconnect with `resume` id.
- Mid-battle disconnect (Phase 3): remaining participants' inputs continue; the
  disconnected player's turns fall back to the initiator's control after a grace
  timeout.

## Directory map

- `server/src/index.js` — HTTP static host (COOP/COEP) + WS endpoint + TCP line
  endpoint; wires modules together.
- `server/src/world/` — presence rooms, roster, flag/var store (+persistence).
- `server/src/battle/` — session FSM, merge rule, seeds.
- `web/js/emu/` — `EmulatorAdapter` interface, `mgba-adapter.js`, `demo-adapter.js`.
- `web/js/bridge/mailbox.js` — TLV codec + EWRAM scanner (mirrors `mailbox.h`).
- `rom/overlay/` — the C netcode dropped into pokeemerald (`src/net/`,
  `include/net/`).
- `rom/lua/mba-bridge.lua` — desktop bridge.
- `emulator/` — vendored VBA-M (reference only; not part of the running stack).
