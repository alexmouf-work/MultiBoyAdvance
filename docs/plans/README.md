# Feature build plans

Detailed, build-ready specs for upcoming features. Each names exact files,
functions, enum values, and message shapes, and honors the standing rule that a
protocol change touches all four implementations (C overlay, JS bridge, Lua
bridge, Node server) + `docs/PROTOCOL.md` + tests in one commit.

- **[TRADING.md](TRADING.md)** — player-to-player trading of Pokémon and items
  between any two online players (offer / accept / counter-offer / reject), custom
  web GUI, PC overflow on receive. Greenfield; mostly full-stack + a small ROM
  addition. Ships in one pass.
- **[TEAM-BATTLES.md](TEAM-BATTLES.md)** — teams (create + invite online players),
  a team-builder GUI, and co-op wild battles where all online members are pulled
  into one deterministic lockstep battle, alternating control with a grey-tint
  spectator view. Extends Phase 3. **Phased**: team formation + GUI + spectator
  veil (T1/T2, low risk) ship before the deep Gen-3 battle-engine work
  (T2.5/T3, high risk — prototype in isolation with a desync detector).

Each plan ends with an **"Open decisions for the owner"** section — confirm those
(especially the team-battle **turn-control model**, D-Turn) before Fable builds.
