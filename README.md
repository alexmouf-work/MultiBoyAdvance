# MultiBoyAdvance

**Shared-world multiplayer Pokémon (Gen 3) — played in the browser, hosted from your own machine.**

MultiBoyAdvance turns a modified `pokeemerald` ROM into a small-group (4–8 player)
shared-world game: everyone walks the same Hoenn at the same time, sees each other
in the overworld, progresses one shared story, and can join each other's battles,
teleport to friends, and fight on-demand PvP.

It works by pairing a **netcode-enabled ROM** with a **host bridge** and a small
**authoritative server**:

```
 Player's browser                                Host machine (Win11, LAN or internet)
 ┌──────────────────────────────┐                ┌───────────────────────────────┐
 │ mGBA (WASM) running the ROM  │                │ Node server (server/)         │
 │   ↕ EWRAM "mailbox" struct   │   WebSocket /  │  • presence rooms (per map)   │
 │ JS bridge reads/writes the   │◀──TCP JSON────▶│  • shared story flags         │
 │ mailbox every frame (web/)   │                │  • battle sessions (merge,    │
 └──────────────────────────────┘                │    seed, turns, outcome)      │
              — or —                             │  • teleport / PvP brokering   │
 ┌──────────────────────────────┐                │  • persistence                │
 │ Desktop mGBA + Lua bridge    │◀──────────────▶│                               │
 │ (rom/lua/) — same protocol   │                └───────────────────────────────┘
 └──────────────────────────────┘
```

The game logic lives **in the ROM** (C, on the pokeemerald decompilation); the
transport lives **outside** it (JS in the browser, Lua on desktop mGBA). They meet
at a fixed, magic-tagged struct in GBA EWRAM — the *mailbox* — so the same ROM
works with both runtimes, and neither the game nor the server cares which one
you use.

## Repository layout

| Directory | What it is |
|---|---|
| [`server/`](server/) | Authoritative Node server: WebSocket + raw-TCP (JSON lines), presence, flags, battles, static hosting of `web/` |
| [`web/`](web/) | Browser client: mGBA-WASM embed, per-frame mailbox bridge, UI overlays. Includes a ROM-free **demo mode** for testing |
| [`rom/`](rom/) | pokeemerald netcode overlay: `net_*.c` modules + mailbox header + integration guide + `setup.sh`. `rom/lua/` is the desktop-mGBA bridge |
| [`docs/`](docs/) | [Architecture](docs/ARCHITECTURE.md) · [Protocol spec](docs/PROTOCOL.md) · [Roadmap](docs/ROADMAP.md) · [Field research](docs/RESEARCH.md) · [Windows setup](docs/SETUP-WINDOWS.md) |
| [`scripts/`](scripts/) | Host-machine helper scripts (Windows PowerShell) |
| [`emulator/`](emulator/) | Vendored VisualBoyAdvance-M source tree (reference / optional desktop runtime). Not required for the multiplayer stack |

## Quickstart (host)

**Windows 11 (one shot):** double-click **`setup-windows.bat`** — it installs
Node if needed, sets up dependencies, verifies with the test suite, optionally
builds the ROM via WSL2, opens the firewall, and starts the server.

Manually (any OS):

```bash
cd server
npm install
npm test        # unit + integration tests
npm start       # serves the web client at http://localhost:8484
```

Open `http://<host-ip>:8484` in a browser on the LAN. Without a ROM you can use
**demo mode** to verify multiplayer sync end-to-end; with a built netcode ROM
(see [`rom/README.md`](rom/README.md)) you get the real game.

Full host setup — building the ROM under WSL2, firewall rules, internet exposure —
is in [`docs/SETUP-WINDOWS.md`](docs/SETUP-WINDOWS.md).

## Status

See [`docs/ROADMAP.md`](docs/ROADMAP.md). Current phase: foundations — server,
web client, bridges, and the ROM overlay scaffolding.

## Legal note

This project contains **no Nintendo assets and no ROMs**. Building the game ROM
requires the pokeemerald decompilation and is intended for personal use with
games you own. The vendored `emulator/` tree is VisualBoyAdvance-M (GPL-2.0);
the browser runtime uses mGBA (MPL-2.0) via the `@thenick775/mgba-wasm` package.
