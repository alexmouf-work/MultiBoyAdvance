# MultiBoyAdvance Protocol Specification

**Version 1.** This document is the single source of truth for both halves of the
protocol. Implementations that must stay in lockstep with it:

| Layer | Implementation |
|---|---|
| EWRAM mailbox (C) | `rom/overlay/include/net/mailbox.h` |
| EWRAM mailbox (JS) | `web/js/bridge/mailbox.js` |
| EWRAM mailbox (Lua) | `rom/lua/mba-bridge.lua` |
| Server wire (JSON) | `server/src/protocol.js`, `web/js/net/socket.js` |

There are two protocol layers:

1. **The mailbox** — a fixed struct in GBA EWRAM through which the *game* (C code
   in the ROM) and the *host bridge* (JS in the browser, or Lua in desktop mGBA)
   exchange binary TLV messages once per frame.
2. **The wire** — JSON messages between the host bridge and the authoritative
   server, over WebSocket (browser) or newline-delimited TCP (Lua/mGBA, which has
   no WebSocket support).

The game never sees the wire; the server never sees the mailbox. The bridge
translates.

---

## 1. The EWRAM mailbox

### 1.1 Location and discovery

The ROM defines a single `struct NetMailbox` instance (`gNetMailbox`) in EWRAM
(`0x02000000`–`0x0203FFFF`), 4-byte aligned, at whatever address the linker picks.
Bridges MUST NOT hard-code the address. Discovery:

1. Scan EWRAM for the 8-byte prefix `4D 42 41 30 01 ..` (`"MBA0"` + version byte;
   the two bytes after version are don't-care during scan) at 4-byte-aligned offsets.
2. Cache the address. Re-verify `magic` + `version` before every frame's exchange;
   if it disappears (reset, new game loaded), re-scan.
3. The game increments `frameCounter` every frame. A bridge that sees a stale
   counter for > 60 exchanges should treat the game as halted.

### 1.2 Struct layout (all little-endian; C is the normative definition)

```
offset size field
 0     4    magic          'M','B','A','0'
 4     1    version        1
 5     1    gameState      0=BOOT 1=OVERWORLD 2=BATTLE 3=MENU 4=OTHER
 6     2    frameCounter   u16, wraps; incremented once per NetTick()
 8     1    playerSlot     0xFF until the host writes the server-assigned slot
 9     1    hostAttached   0 until a bridge writes 1; game may show "online" UI
10     6    reserved       zero
16     4+512  out ring     game → host   (head u16, tail u16, buf[512])
532    4+512  in ring      host → game   (head u16, tail u16, buf[512])
```

Total size: 1048 bytes.

### 1.3 Rings

Single-producer / single-consumer circular byte buffers.

- `head`: next write index (owned by producer). `tail`: next read index (owned by
  consumer). Empty when `head == tail`; the ring holds at most 511 bytes.
- Producers write the whole TLV record then advance `head` once (record-atomic:
  the head is only published after the full record is in the buffer).
- The **game** produces `out` and consumes `in`, inside `NetTick()` once per frame.
- The **bridge** consumes `out` and produces `in`, inside its per-frame callback.
  Because both sides run strictly frame-interleaved (the bridge callback runs
  while the core is paused between frames), no further synchronization is needed.

### 1.4 TLV records

```
[type u8][len u8][payload: len bytes]
```

`len` is the payload length only. Unknown types MUST be skipped (len makes every
record self-delimiting). Types `0x01–0x7F` flow game→host, `0x80–0xFF` host→game.

#### Game → host

| Type | Name | Payload |
|---|---|---|
| 0x01 | `PRESENCE` | mapGroup u8, mapNum u8, x s16, y s16, facing u8, moveState u8 — sent when position/map/facing changes, at most once per frame |
| 0x02 | `FLAG_SET` | flagId u16 — a synced story flag was set locally |
| 0x03 | `VAR_SET` | varId u16, value u16 |
| 0x05 | `PARTY_SUMMARY` | count u8, then per mon: species u16, level u8, hpPct u8 — sent on party change; drives roster UI |
| 0x07 | `PARTY_FULL` | count u8, then count × 32-byte wire mons (§1.5) — sent on party change; the server merges these for co-op battles |
| 0x06 | `REQUEST` | sub u8, arg u8: sub 1=teleport-to-slot(arg), 2=pvp-challenge(arg), 3=pvp-accept(arg), 4=resync (arg unused; a fresh save asks the server to replay world flags/vars + identity) |
| 0x0F | `LOG` | raw ASCII text (≤48 bytes) — the game's debug feed (`NetLog`/`NetLogNum`). Bridges surface it locally (web Debug panel / mGBA console); it is NOT forwarded to the server |
| 0x10 | `BATTLE_EVENT` | sub u8, then: sub 1=ENCOUNTER_OPEN {kind u8, opponent u16}; sub 2=TURN_INPUT {turn u8, action u8, moveSlot u8, target u8, extra u16}; sub 3=OUTCOME {result u8: 1=win 2=loss 3=flee} |
| 0x11 | `SAVED` | no payload — the game wrote its flash save (first save, map-change save, or a manual START-menu save). The web bridge reacts by mirroring the .sav to IndexedDB and `PUT /api/save/<name>` |
| 0x12 | `SAVEBLOCKS` | mailboxAddr u32, saveCounter u32, lastWrittenSector u8, then 3 × {ptr u32, size u32} for SaveBlock2 / SaveBlock1 / PokemonStorage — the freeze-free save path (§1.7); emitted every ~10s from the overworld after `CopyPartyAndObjectsToSave` |
| 0x7F | `HELLO` | version u8 — game finished booting netcode |

#### Host → game

| Type | Name | Payload |
|---|---|---|
| 0x81 | `GHOST` | slot u8, active u8, mapGroup u8, mapNum u8, x s16, y s16, facing u8, moveState u8 — position of another player; active=0 means despawn |
| 0x82 | `FLAG_APPLY` | flagId u16 — set this flag (arrived from world state) |
| 0x83 | `VAR_APPLY` | varId u16, value u16 |
| 0x85 | `WARP` | mapGroup u8, mapNum u8, x s16, y s16 — teleport the local player (applied at next safe overworld frame) |
| 0x86 | `ASSIGN` | slot u8 — server-assigned player slot (bridge also writes `playerSlot` in the header) |
| 0x90 | `BATTLE_CMD` | sub u8, then: sub 1=START {seed u32, playerCount u8, order[4] u8, mode u8}; sub 2=TURN_INPUT {turn u8, fromSlot u8, action u8, moveSlot u8, target u8, extra u16}; sub 3=END {result u8}; sub 4=PARTY {count u8, count × 32-byte wire mons} — sent *before* START; the ROM stages it and injects at START (co-op), restoring the original party at END |
| 0x91 | `ADMIN` | sub u8, then per-sub fields (§1.6) — console/server-initiated actions applied to the local game |

### 1.5 Wire mon (32 bytes, little-endian)

The transferable encoding of one Pokémon — enough to reconstruct a
battle-identical mon via `CreateMon` + `SetMonData` on every participant:

```
offset size field
 0     4    personality (nature/gender/shiny derive from this + otId)
 4     4    otId
 8     2    species
10     2    heldItem
12     8    moves[4] (u16 each)
20     1    level
21     1    abilityNum
22     4    ivs — 6 stats × 5 bits, bit 0..29, HP first
26     6    evs — hp, atk, def, speed, spatk, spdef (u8 each)
```

Normative C codec: `MonToWire`/`MonFromWire` in `rom/overlay/src/net_battle.c`.
In wire JSON, a wire mon travels as `b` = array of 32 integers, alongside `lv`
(duplicated from byte 20) so the server can apply the merge rule without
parsing the blob.

### 1.6 ADMIN subtypes (0x91, host → game)

Console commands, trades, and the starter kit all land in the game through this
one TLV. Normative C handler: `NetOnAdminCmd` in `rom/overlay/src/net_admin.c`.

| Sub | Name | Payload after sub | Effect |
|---|---|---|---|
| 1 | `GIVE_ITEM` | itemId u16, qty u16 | `AddBagItem` |
| 2 | `TAKE_ITEM` | itemId u16, qty u16 | `RemoveBagItem` (trade sender's side) |
| 3 | `GIVE_MON` | species u16, level u8 | create + add to party (random IVs), then re-report the party |
| 4 | `SET_LEVEL` | partySlot u8 (0-based), level u8 | set exp to the level threshold, recalc stats |
| 5 | `GIVE_XP` | partySlot u8, xp u32 | add exp (capped at max), recalc stats |
| 6 | `WILD_BATTLE` | species u16, level u8 | scripted wild battle; only fires from a quiet overworld frame |
| 7 | `RESET_TRAINER` | trainerId u16 | clear the trainer's defeated flag (rewards stay awarded) |
| 8 | `SET_NAME` | up to 8 charmap bytes, EOS(0xFF)-padded | write the player's registered name into the save (server encodes ASCII → game charset) |
### 1.7 Freeze-free saves (SAVEBLOCKS → `save.blocks` → forge)

A real flash save halts the game ~2s (emulated flash handshakes), but the
.sav is a pure function of three RAM blocks. So: every ~10s the ROM refreshes
those blocks (`CopyPartyAndObjectsToSave`, a memcpy) and publishes their
addresses/sizes + `gSaveCounter`/`gLastWrittenSector` via SAVEBLOCKS. The
bridge — which runs between frames, so the snapshot is consistent by
construction — reads the bytes and sends them as `save.blocks` (base64). The
SERVER then forges a byte-exact .sav (`server/src/saveforge.js` mirrors
`save.c`: counter+1, sector rotation, per-sector checksums/signature) onto
the trainer's stored image and persists it. The game never freezes; real
flash saves remain for manual saves, the first-join baseline, and map
changes (where the pause hides in the transition).

GBA→host address translation uses the mailbox as the fixed point:
`heapOffset = mailboxHeapBase + (gbaPtr - mailboxAddr)` (browser), or
`ewramOffset = gbaPtr - 0x02000000` (Lua).


---

## 2. The wire (bridge ⇄ server)

JSON objects. Transport framing:

- **WebSocket** (browser): one JSON object per text message. Path: `ws://host:8484/ws`.
- **TCP** (mGBA Lua): newline-delimited JSON on port **8485**. Identical schema.

Every message has `t` (type). Server assigns each connection an integer `slot`
(0–7) for compactness; `id` is a longer opaque string used for reconnection.

### 2.1 Bridge → server

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `name` string, `proto` 1, `resume?` id | join the world (or resume a session) |
| `pos` | `g,n` map group/num, `x,y` s16, `f` facing, `s` moveState | local player moved |
| `flag` | `id` int | synced flag was set locally |
| `var` | `id` int, `v` int | synced var changed |
| `party` | `mons` [{`sp`,`lv`,`hp`}] | party summary (roster UI) |
| `party.full` | `mons` [{`lv`, `b`:[32 ints]}] | full wire mons (§1.5) for co-op merges |
| `battle.open` | `kind` int, `opp` int | local player is entering a battle; open a join window |
| `battle.join` | `sid` string | join battle session `sid` (spectate→control) |
| `battle.input` | `sid`, `turn`, `a`, `move`, `tgt`, `x` | turn input |
| `battle.end` | `sid`, `result` 1/2/3 | initiator reports outcome |
| `tp` | `to` slot | ask to teleport to player `to` (they must accept — "/tpa" style) |
| `tp.accept` | `from` slot | accept a pending teleport request (requests expire after 60 s) |
| `pvp` | `to` slot | challenge player `to` |
| `pvp.accept` | `from` slot | accept a challenge |
| `trade.give` | `to` slot, `item` int, `qty` int | hand items to a nearby player (server relays `take_item`/`give_item` admin msgs) |
| `starter` | `species` int (252/255/258) | new-player kit: chosen starter lv5 + 5 Poké Balls + 3 Potions (once per connection) |
| `cmd` | `line` string (≤200 chars) | console command (see `/help`); server replies `cmd.result` |
| `resync` | — | fresh save requests the world flags/vars + identity again (reply: `sync` + `admin set_name`); sent by the ROM right after the multiplayer quick start |
| `save.blocks` | `counter` int, `sector` int, `sb2`/`sb1`/`sto` base64 | freeze-free save snapshot (§1.7); the server forges + stores the trainer's .sav. Rate-limited server-side (≥3s apart) |
| `speed` | `x` int 1–4 | set the shared emulator speed — one world, one clock |
| `ping` | — | keepalive (expect `pong`) |

### 2.2 Server → bridge

| `t` | Fields | Meaning |
|---|---|---|
| `welcome` | `id`, `slot`, `players` [{slot,name,onlineMs}], `users` (see `users`), `flags` [int], `vars` [[id,v]], `speed` int | join accepted; replay world state (`onlineMs` = how long each player has been connected) |
| `join` / `leave` | `slot`, `name?` | roster changes |
| `users` | `users` [{`name`, `online` bool, `slot?`, `g?,n?,x?,y?`, `lastSeenAt?` ms-epoch}] | the trainer registry: every player ever seen, with current (online) or last (offline) location; broadcast on join/leave |
| `ghost` | `slot,g,n,x,y,f,s` | another player's presence (only sent to players on the same map; a synthetic `s:255` despawns) |
| `flag` / `var` | `id`, `v?` | authoritative world-state update |
| `battle.offer` | `sid`, `from` slot, `kind`, `opp`, `ttl` ms | someone opened a battle you may join |
| `battle.start` | `sid`, `seed`, `order` [slots], `party` [summary mons], `partyWire` [[32 ints]] (co-op only), `bags` {slot:[...]} | session begins (merged party, shared seed, turn order) |
| `battle.input` | `sid`, `turn`, `from`, `a`, `move`, `tgt`, `x` | relayed turn input |
| `battle.end` | `sid`, `result`, `warp?` {g,n,x,y} | session over; optional respawn/return warp |
| `warp` | `g,n,x,y` | teleport instruction (accepted tp / pvp / whiteout / `/warp`) |
| `pvp.req` | `from` slot, `name` | incoming challenge |
| `tp.req` | `from` slot, `name` | player `from` asks to teleport to you; reply `tp.accept` to allow it |
| `admin` | `sub` string + per-sub fields | apply an admin action to your game; the bridge encodes it as ADMIN TLV §1.6 (`sub` strings: `give_item`, `take_item`, `give_mon`, `set_level`, `give_xp`, `wild_battle`, `reset_trainer`) |
| `trade.recv` | `from` slot, `name`, `item`, `qty` | someone handed you items (UI notice; the bag change arrives via `admin`) |
| `cmd.result` | `ok` bool, `msg` string | console command reply |
| `sync` | `flags` [int], `vars` [[id,v]] | world-state replay outside `welcome` (answers `resync` — new-game init wiped what the welcome applied) |
| `speed` | `x` int 1–4 | authoritative shared speed; every bridge applies it to its emulator |
| `pong` / `error` | — / `msg` | |

### 2.3 Authority rules

- **Presence**: client-authoritative (soft sync). The server only routes, with
  per-map interest management.
- **Flags/vars**: server-authoritative. Locally set flags are *reported*; the
  server records and broadcasts them (including back to the sender — the ROM
  applies idempotently). Only IDs within the configured synced ranges are accepted.
- **Battles**: the server owns session lifecycle, the merged party (rule below),
  the RNG seed, and turn order; clients own only their own turn inputs. Outcome
  is reported by the initiating client in Phase 3 (server-side validation is a
  Phase 5 hardening item).
- **Party merge rule**: participants sorted stable; from each, take its top
  `ceil(6 / N)` Pokémon by level (tie-break: earlier party position), then trim
  to 6 by highest level overall.
- **Teleports are consensual**: `tp` never moves anyone by itself — the server
  parks the request on the target for 60 s and only an explicit `tp.accept`
  produces the `warp` (sent to the requester, at the target's position then).
- **Console commands** (`cmd`) run under the friends-trust model: any connected
  player may run them; the server validates arguments and routes `admin`
  messages to the target bridge. `docs/PROTOCOL.md` intentionally does not gate
  them behind roles — this is a private co-op world.

### 2.4 HTTP side-channel

`GET/HEAD /rom/mba.gba` — the host's current local ROM build
(`rom/build/mba.gba`), served `no-store` so a rebuild is picked up on the next
join. 404 when the host hasn't built one. The build never enters the git repo;
it exists only on the host's server.

`GET/PUT /api/save/<name>` — the trainer's game save (.sav flash image,
≤256 KB). Bridges PUT it after every `SAVED` report, and the server itself
refreshes the same file every ~10s from `save.blocks` forging (§1.7); the
join flow GETs it and stages it in the emulator before boot, so CONTINUE
picks up where the last sync left off on any device. Keys are the registry's case-insensitive
trainer names (filename-safe characters only); files live in
`server/data/saves/`. The server copy wins over the browser's IndexedDB copy
at boot.

`GET /api/users` — `{users: [...]}` in the same shape as the `users` wire
message. The join screen uses it (before any WebSocket exists) to list
returning trainers, their online status, and where they were last seen; one
click joins as that trainer. Trainer records persist in the server's world
state file (`server/data/`), keyed case-insensitively by name — friends-trust
model, no passwords.

### 2.5 Timing

- Presence: bridge sends `pos` only on change, throttled to 10/s.
- Ghost fan-out: immediate on receipt (≤ 8 players; no batching needed).
- Battle join window (`ttl`): default 10 000 ms.
- Keepalive: bridges ping every 15 s; server drops connections silent for 60 s.
