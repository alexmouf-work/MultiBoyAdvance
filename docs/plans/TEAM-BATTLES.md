# Build plan — Team (co-op) battles

Status: **design complete, unbuilt.** Author: planning session (Opus). Builder: Claude Fable.
Companion: `docs/plans/TRADING.md`. Normative protocol: `docs/PROTOCOL.md`.
Roadmap: this is the completion + extension of **Phase 3 (co-op battles)**.

> **Read this first.** Team battles are the single hardest thing in the project.
> The merged party, shared RNG seed, and party injection **already exist** in the
> overlay — but three load-bearing pieces do **not**, and the owner's spec needs
> all three:
> 1. Non-initiating peers never actually **enter** the battle (the START handler
>    only bookkeeps + injects the party + seeds RNG — no `BattleSetup` call).
> 2. Relayed **turn inputs are not fed into the battle engine** (the handler is a
>    one-line stub).
> 3. Turn **order is stored but never applied**, and the **enemy is never synced**
>    (each ROM would generate a different wild mon → instant desync).
>
> This plan closes them, but it phases the risk so most of the visible value ships
> before the deep battle-engine surgery.

---

## 1. What we're building (from the owner's spec)

- A player **creates a team** and **invites** other players. Invites are visible
  when the invitee is **online**; **offline players can't be invited**.
- Team **max size 3** (A, B, C).
- Default battle lineup = **each member's top 3 Pokémon, interleaved**, creator
  first: for two members `A1,B1,A2,B2,A3,B3`; for three `A1,B1,C1,A2,B2,C2`.
- A **dedicated GUI** lets the team decide **which Pokémon the team uses and in
  what order** (override the auto top-3 + reorder).
- When a team member **runs into a wild encounter**, **all online team members are
  pulled into the battle GUI regardless of location.** The member who hit the
  encounter takes the **first turn**.
- **Players alternate turns.** When it isn't your turn you see **the same battle
  screen the active player sees, with a pale-grey tint** over it.

### Scope for v1 (state plainly)
- **Wild single battles only.** Trainer/gym battles (enemy party + AI must be
  replicated on every peer) are out of v1 — see §12.
- **Turn-control model (CONFIRMED by owner):** control **rotates per turn**
  through the team in team order, starting with the encounter's initiator
  (A→B→C→A…), decoupled from which Pokémon is currently on the field (the
  interleaved lineup only sets *send-out* order). This is the literal reading of
  "players alternate turns" + "order of Pokémon A1,B1,…". Build to this.
- Teams are **ephemeral** (in-memory, dissolve when the leader disconnects or
  disbands). Cross-session persistent teams are a §12 enhancement.

---

## 2. The core architecture decision: lockstep, not streaming

"Both players see the same battle screen" has two possible implementations:

- **(chosen) Deterministic lockstep.** *Every* participant's local emulator runs
  the *identical* battle: same merged party, same enemy, same RNG seed, same
  per-turn inputs. Because it's deterministic, all screens match frame-for-frame
  without shipping any video. The "grey tint" is just a web overlay on whoever
  isn't choosing this turn. **This is exactly how Gen-3 link battles already work**
  (each GBA runs the whole battle and only *exchanges the players' choices* over
  the cable). We reuse that idea, replacing the link cable with our mailbox+server
  relay. The existing overlay already does the two hardest prerequisites (merged
  party injection + shared seed).
- **(rejected) Framebuffer streaming.** One ROM runs the battle and streams pixels
  to spectators. Heavy bandwidth, adds latency, wastes the local emulator each
  client already has, and can't give a spectator real control. Not used.

Everything below builds the lockstep model.

---

## 3. Phasing (ship value early, quarantine the hard part)

| Phase | Deliverable | Risk | Testable in demo mode? |
|-------|-------------|------|------------------------|
| **T1** | Team formation, invites (online-only), the team-builder GUI, lineup persistence. **No battle changes.** | low | yes, fully |
| **T2** | Server team-battle *session* (seed, merged lineup, **enemy transfer**, per-turn controller schedule) + web **spectator view with grey tint** driven by turn signals. Battle is simulated by the demo adapter. | medium | yes |
| **T2.5** | ROM: **peer battle entry** + **single-source input injection** (initiator controls *all* turns, peers spectate the identical live battle). Proves determinism + injection without rotation. | **high** | partial (needs real ROM) |
| **T3** | ROM: **rotate control per turn** among members (multiple input sources) + desync detector. This is full co-op. | **highest** | partial |

If T3 proves too costly, **T2.5 is a shippable product**: teammates are pulled
into the *real* shared battle and watch it live (always grey-tinted), even though
only the initiator issues commands. T3 upgrades that to true alternating control.

---

## 4. Data model

### 4.1 Team (server, in-memory)
`World.teams: Map<teamId, Team>` where `teamId` = the leader's slot at creation
time (stable string like `"t3"`). Add `client.teamId` to `Client` (constructor,
`world.js:45`).
```jsonc
Team {
  id: "t3",
  leader: 3,                 // slot
  members: [3, 5],           // slots, leader first; max 3
  invites: Map<slot, ms>,    // pending invites keyed by invitee slot (TTL)
  lineup: {                  // the team-builder result (see 4.2)
    3: [0, 2],               // member slot -> ordered list of party indices they contribute
    5: [1]
  }
}
```
Module constants near `TP_REQUEST_TTL_MS` (`world.js:15`):
`const TEAM_INVITE_TTL_MS = 120_000; const TEAM_MAX = 3;`

### 4.2 Lineup → merged battle order
Each member contributes an **ordered** list of their party indices (default = top
3 by level, from `client.party` summaries). The merged send-out order interleaves
by rank then member order:
```
merged = []
for rank in 0..2:
  for member in team.members (leader first):
    if lineup[member][rank] exists: merged.push({owner: member, idx: lineup[member][rank]})
merged = merged.slice(0, 6)   // party cap
```
This yields `A1,B1,(C1),A2,B2,(C2),…` exactly. The **wire** party shipped to ROMs
is `merged.map(m => clients[m.owner].fullMons[m.idx].b)` (32-byte wire mons the
server already holds from `party.full`).

### 4.3 Turn-controller schedule
Deterministic from the team order + a turn counter, computed identically by the
server (for the web grey-tint signal) and every ROM (for input gating):
```
controller(turn) = team.members[(initiatorIndex + turn) % team.members.length]
// turn is 0-based; turn 0 => initiator (spec: initiator takes the first turn)
```

---

## 5. Protocol additions (the lockstep set)

### 5.1 New JSON wire messages
**Client → server** (`CLIENT_MESSAGES` in `protocol.js`, required numeric fields):
| type | required | notes |
|------|----------|-------|
| `team.create` | `[]` | create/lead a team (idempotent if already leader) |
| `team.invite` | `['to']` | invite a slot (online-only) |
| `team.accept` | `['from']` | accept an invite from a leader slot |
| `team.reject` | `['from']` | decline |
| `team.leave`  | `[]` | leave / disband if leader |
| `team.lineup` | `[]` | set my contributed party indices `{picks:[idx,…]}` (validated in handler) |
| `battle.turn.input` | `['sid','turn','a']` | the controller's chosen action for a turn (see §7). *(distinct from co-op `battle.input`; or reuse `battle.input` — see note)* |

> **Reuse note:** `battle.input` already exists (`{sid,turn,a,move,tgt,x}`) and the
> server already relays it to session participants (`relayInput`). Team battles can
> **reuse `battle.input`** for the controller's choice rather than adding
> `battle.turn.input`. Prefer reuse; the row above documents the payload either way.

**Server → client** (documented in `docs/PROTOCOL.md §2.2`):
| type | fields | drives |
|------|--------|--------|
| `team.req`    | `{from, name}` | "invited to {name}'s team" toast |
| `team.update` | `{id, leader, members:[{slot,name}], lineup}` | team panel / builder GUI refresh |
| `team.left`   | `{slot, disbanded?}` | member left / team dissolved |
| `battle.turn` | `{sid, turn, controller}` | web grey-tint: grey unless `controller===mySlot` |

The existing `battle.start` gains fields (below); `battle.input`/`battle.end` are
reused as-is.

### 5.2 `battle.start` payload additions (server → client)
Add to `BattleSession.startPayload()` (`session.js`), for `mode:'team'`:
- `mode: 'team'`
- `enemy: [wireMon,…]` — **the exact wild enemy** (from the initiator; §6.2). This
  is the missing determinism input.
- `order` already carries participant slots; for teams it's the **team order**
  (leader first) so `controller(turn)` is well-defined on every client.

### 5.3 New EWRAM mailbox TLVs / sub-codes
1. **Enemy transfer at encounter** — extend the existing encounter report so the
   initiator ships the enemy mon, not just its species. Two options:
   - (chosen) **Grow `NET_MSG_BATTLE_EVENT` sub 1 (ENCOUNTER)** to optionally
     carry a 32-byte enemy wire mon after `{kind,opp}` (len tells peers whether
     it's present). The bridge forwards it in `battle.open` as `enemy:[wire]`.
   - (alt) a dedicated `NET_MSG_ENCOUNTER_MON` TLV. Prefer extending sub 1.
2. **Peer battle entry** — a new host→game `NET_BSUB` on `BATTLE_CMD (0x90)`:
   `NET_BSUB_START` already exists (sub 1) and is where peers receive
   seed/order/party. Extend the START payload to also carry the **enemy wire
   mon(s)** and `mode:'team'`, and make the START handler actually **launch the
   battle** on a peer (§7.1). No new sub-code needed — extend sub 1's payload +
   behavior. (Bump the documented START length.)
3. **Turn gating / relayed input** — reuse `NET_BSUB_TURN_INPUT` (sub 2), which is
   already defined both directions; wire it into the engine (§7.2). Add a
   game→host **turn-begin** signal so the web UI can grey the screen: extend
   `NET_MSG_BATTLE_EVENT` with **sub 4 = TURN_BEGIN** `{turn u8, controller u8}`
   emitted at the start of each action-selection (§7.3).
4. **Desync hash** (T3 safety) — game→host `NET_MSG_BATTLE_EVENT` **sub 5 =
   STATEHASH** `{turn u8, hash u32}` (§9). Server compares across participants.

All of the above are additive; keep the four implementations + `docs/PROTOCOL.md`
in lockstep in each commit.

---

## 6. Server changes (`server/src/`)

### 6.1 Team lifecycle (`world.js`)
Dispatch cases for `team.create/invite/accept/reject/leave/lineup`. Mirror the
**teleport** handshake for invites (stored on the invitee with TTL, verified at
accept):
- `_onTeamInvite`: guard target online (`clients.get(msg.to)`), guard team not
  full (`team.members.length < TEAM_MAX`), store `team.invites.set(to, now)`,
  send `team.req` to the invitee.
- `_onTeamAccept`: read+delete the invite, TTL-check, add invitee to `team.members`
  + set `invitee.teamId`, broadcast `team.update` to all members.
- `_onTeamLineup`: validate the picks are real party indices (against
  `client.party`), store into `team.lineup[slot]`, broadcast `team.update`.
- `_onTeamLeave` / `removeClient`: remove from `members`; if the leader leaves,
  **disband** (clear every member's `teamId`, send `team.left {disbanded:true}`,
  delete the team). GC invites referencing the leaver.

### 6.2 Team battle session (`world.js` + `session.js`)
When `_onBattleOpen` fires and `client.teamId` is set:
- Build participants = **all online team members** (not the map-wide join window).
- Create a `BattleSession(initiator, {kind, opp, mode:'team', enemy: msg.enemy}, 0, …)`
  (join window `0` — the team is pre-formed, start immediately with the online
  members).
- `startPayload()` for `mode:'team'`: `seed` (already), `order` = team order
  (leader first), `partyWire` = merged lineup wire (§4.2, using
  `mergeWireParties` but with the team lineup selection instead of auto top-3 —
  generalize `merge.js` to accept an explicit per-member index list), `enemy`
  (from the initiator's `battle.open`), `mode:'team'`.
- Send identical `battle.start` to every participant.

### 6.3 Turn relay + controller signal
- Reuse `relayInput` (`session.js`) to echo the controller's `battle.input` to the
  other participants (already implemented — echoes to all except sender).
- Add a `battle.turn {sid, turn, controller}` fan-out: when the ROM emits
  TURN_BEGIN (bridge → `battle.turn.begin`), the server computes/echoes
  `controller = order[(initiatorIndex + turn) % N]` to all participants for the
  grey-tint. (Or the client computes it locally from `order` + `turn` and the
  server signal is only a sync/authority check.)
- `battle.end` already only honors the **initiator's** report and computes the
  regroup warp — reuse unchanged; teammates get the win-warp back to their own
  prior position (they never physically moved, so the warp is a no-op/return).

### 6.4 `merge.js`
Generalize `mergeWireParties(participants, lineup?)`: when a `lineup` (per-member
ordered index list) is supplied, build the merged order from it (interleaved by
rank) instead of the auto "top ceil(6/N) by level". Keep the auto path as the
default when a member has no lineup set.

### 6.5 `commands.js`
Add `/team create`, `/team invite <player>`, `/team leave`, `/team list` as a
no-GUI path (e2e + power users), routed through `findTarget` + the same handlers.

---

## 7. ROM overlay — the hard part (`rom/overlay/`)

All three sub-problems live in the battle engine, **inside** a battle (so the
`CB2_Overworld` guard does *not* apply — use battle-state guards instead:
`gBattleTypeFlags`, `gBattlersCount`, `GetBattlerSide`, `sSession.active`).

### 7.1 Peer battle **entry** (T2.5)
Today `NetOnBattleCmd` START only sets `sSession`, injects the party, seeds RNG.
Make a **non-initiator** actually start the identical battle:
- Parse the extended START payload: enemy wire mon(s), `mode`, order, seed.
- Recreate the enemy: `MonFromWire` → `gEnemyParty[0]`, `CalculatePlayerPartyCount`
  equivalent for the enemy, set `gEnemyPartyCount`.
- Set the same battle flags the initiator's wild battle uses and launch the battle
  transition. The **safe, proven path** is the one `NET_ADMIN_WILD_BATTLE` already
  uses: `CreateScriptedWildMon` + `BattleSetup_StartScriptedWildBattle` — but we
  must start it with the **shipped** enemy (not a freshly rolled one). Investigate
  whether to (a) call the scripted-wild-battle setup then overwrite `gEnemyParty[0]`
  from the wire before the intro reads it, or (b) set
  `gBattleTypeFlags`/`gMain.savedCallback` and call `SetMainCallback2(CB2_InitBattle)`
  directly. Prototype both.
- Guard entry to a **safe overworld frame** on the peer (`CB2_Overworld` +
  `!ArePlayerFieldControlsLocked()`) — same discipline as warps/scripted battles;
  queue the START until the peer is on a quiet frame (a member could be mid-script
  when the encounter fires elsewhere). On battle end, `RestorePartyIfInjected()`
  already restores their real party; they resume where they stood.
- New ci-stubs likely needed: `gEnemyParty`, `gEnemyPartyCount`,
  `CreateScriptedWildMon`, `BattleSetup_StartScriptedWildBattle`,
  `gBattleTypeFlags`, `CB2_InitBattle` (some already exist — audit
  `rom/ci-stubs/`).

### 7.2 Feed relayed inputs into the engine (T2.5 single-source, T3 rotate)
The player's action/move choice in pokeemerald is produced by the **player battle
controller** (`HandleInputChooseAction` / `HandleInputChooseMove`), which ends by
calling `BtlController_EmitTwoReturnValues(BUFFER_B, B_ACTION_USE_MOVE,
chosenMoveIndex | (target << 8))` and stamping `gChosenActionByBattler[i]` /
`gChosenMoveByBattler[i]`. Two strategies:

- **R2 (recommended first cut).** Intercept the player controller so that, when
  **this client is not the controller for this turn**, it *does not* read local
  input; instead it **waits for the relayed `NET_BSUB_TURN_INPUT`** and then emits
  exactly that action via `BtlController_EmitTwoReturnValues` (+ the move/target).
  When it **is** the controller, run the normal input handler and, once the choice
  is locked, **relay it** (this is what `NetOnTurnFinalized` already emits — reuse
  it as the send side). Concretely: add a `NetBattleWantsControl()` predicate
  (`slot == controller(turn)`); hook the top of the player action/move handlers to
  branch on it. This is a **custom, minimal** injection that does not convert the
  battle to a link battle — so **you own determinism** (§9).
- **R1 (high-fidelity, later).** Piggyback pokeemerald's **link-battle** input
  exchange: set `BATTLE_TYPE_LINK`-style handling and feed relayed inputs through
  the `gBlockRecvBuffer` path the native link controllers already read, so the
  stock engine does the lockstep it was designed for. Highest fidelity and least
  bespoke determinism risk, but a large integration (link setup assumes N linked
  consoles). Consider for trainer battles / v2.

For **T2.5**, controller is *always the initiator* → every peer injects the
initiator's relayed inputs for every turn (one input source; simplest path to
prove entry+injection+determinism). For **T3**, `controller(turn)` rotates, so the
"am I controller?" predicate flips per turn and the relay source rotates.

### 7.3 Turn-begin signal (grey tint) — `NET_MSG_BATTLE_EVENT` sub 4
At the start of each action-selection phase (hook where `PlayerHandleChooseAction`
/ the action menu opens), emit `{sub:4 TURN_BEGIN, turn: sSession.turnNo,
controller: computed}`. The bridge forwards `battle.turn.begin`; the web UI greys
the screen when `controller !== mySlot`. Also used by the controller's own client
to *enable* input.

### 7.4 Suppress local input for non-controllers
When `!NetBattleWantsControl()`, the action/move handlers must not act on the
player's key presses (block A/B/D-pad in the selection handlers) so a spectator
can't drive the battle. The web UI additionally stops sending pad input while
grey (belt-and-suspenders), but the ROM guard is the authority.

### 7.5 NetTick wiring
Add `NetBattleTick`'s existing slot is fine; the new logic is inside battle
controller hooks, not a new per-frame producer. If a small per-frame battle-state
pump is needed (e.g. applying a queued relayed input the moment the engine asks
for it), add `NetTeamBattleTick()` to `NetTick()` after `NetApplyIncoming()`.

### 7.6 New hooks (via `rom/setup.sh`, documented in `rom/README.md`)
- `battle_setup.c` (existing encounter hook): also serialize `gEnemyParty[0]` into
  the `NetOnBattleOpen` payload.
- The player battle controller file (`battle_controller_player.c`): hook the
  choose-action / choose-move entry points for §7.2/§7.4 (new hook; guard by
  `sSession.active && sSession.mode == team`).
- Keep every new hook `grep`-anchored + idempotent like the existing eight.

---

## 8. Web UI (`web/`)

### 8.1 Team panel + invites
- **Roster buttons** (`ui.js #renderPlayers`, next to `tp`/`pvp`): add
  `data-action="team-invite"` per online player (leader only, when a team exists),
  and a top-level "**Create team**" affordance (e.g. in the sidebar).
- **Invite toast** (`#toast`): `s.on('team.req', m => #toast(`👥 ${m.name} invited
  you to a team`, {action:'team-accept', label:'Accept', ttl:115000,
  onAction:()=>socket.send({t:'team.accept', from:m.from})}))`.
- **Team panel** in the sidebar (new `.panel`): render `team.update` — members,
  who's leader, a "Leave/Disband" button.

### 8.2 Team-builder GUI (mirror `#starter-modal`/`.starter-card`, z-index 85)
New `#team-modal`. Shows, per member (from `team.update` + party summaries the UI
already receives):
- The member's party (species + level chips) with checkboxes / drag to pick **up
  to 3** and order them → `socket.send({t:'team.lineup', picks:[idx,…]})`.
- A read-only **preview of the merged lineup** (`A1,B1,C1,A2,…`) computed with the
  §4.2 rule so the team can see the final order before battle.
- Leader may reorder the merged list (optional for v1).

### 8.3 In-battle spectator view (grey tint)
- On `battle.start {mode:'team'}`, show a full-`#gamewrap` overlay element
  `#battle-turn-veil` (absolute, `inset:0`, `z-index:55` — above the game (50),
  below toasts (70)), `background: rgba(120,120,120,0.35)`, `pointer-events:none`.
- Toggle it on every `battle.turn` (or `battle.turn.begin`): **hidden when
  `controller === mySlot`, shown otherwise**, plus a small banner "P{controller+1}
  is choosing…". This is the "pale grey tint when it's not your turn."
- While veiled, the web input layer suppresses pad presses (the ROM already
  refuses them; this just avoids confusing the local player).
- Remove the veil on `battle.end`.

### 8.4 Bridge (`web/js/bridge/bridge.js`)
- Forward the new game→host events: TURN_BEGIN (sub 4) → `socket`? No — it's local;
  emit an internal event the UI listens to for the veil, AND (if the server needs
  it) send `{t:'battle.turn.begin', sid, turn, controller}`.
- START/`battle.start` handler: already stages `partyWire` + START; extend to pass
  the new `enemy` + `mode` fields through `enc.battleStart` (grow the encoder).
- Reuse the existing `battle.input` relay handlers.

### 8.5 Demo adapter (`web/js/emu/demo-adapter.js`)
Teach it a **scripted team battle** so T1/T2 are fully e2e-testable without a ROM:
on `battle.start {mode:'team'}`, run a tiny turn loop that emits `battle.turn`
signals and accepts `battle.input`, recording `events` (`battle.turn`,
`battle.input.applied`, `battle.ended`) for assertions and toggling the veil.

---

## 9. Determinism & desync detection (essential for T2.5/T3)

Custom injection (R2) means **we** guarantee identical simulation. Sources of
desync to control:
- **Same inputs everywhere:** every participant must inject the *same* controller
  choice for a turn — enforce by keying relayed inputs on `(sid, turn)` and
  ignoring duplicates/out-of-order.
- **Same enemy:** shipped via wire (don't re-roll).
- **Same seed:** already applied (`SeedRng`/`SeedRng2` at START).
- **Same party:** already injected.
- **No local-only RNG divergence:** audit any overlay code that calls RNG during
  battle; none should run per-client.

**Desync detector:** each ROM emits `NET_MSG_BATTLE_EVENT` sub 5 STATEHASH
`{turn, hash}` at TURN_BEGIN, where `hash` folds a few canonical fields (turn,
both active battlers' species + current HP, `gRngValue`). The server compares
hashes across participants for the same `(sid, turn)`; a mismatch → log + send
`battle.desync {sid, turn}` and (v1) **abort the co-op battle gracefully** (fall
back to the initiator finishing solo, peers exit the battle). Without this, a
single divergence corrupts everyone silently. Build the detector **alongside**
T2.5, not after.

---

## 10. End-to-end flows

**Form a team (T1):**
```
A: Create team -> team.create ; A invites B -> team.invite{to:B}
B: toast "A invited you" -> team.accept{from:A}
Server: add B, team.update -> A,B (panel shows both)
Both open team-builder -> team.lineup{picks} each -> team.update refreshes preview
```

**Team wild battle (T2.5/T3):**
```
A walks into grass, hits a wild mon.
  ROM(A): NetOnBattleOpen(kind=0, opp=species, enemyWire=serialize(gEnemyParty[0]))
  Server: A.teamId set -> new team BattleSession(participants = online members),
          battle.start{seed, order=[A,B], mode:team, partyWire=mergedLineup, enemy:[wire]} -> A,B
  ROM(A): already in its wild battle (initiator). Injects merged party, seeds RNG.
  ROM(B): peer entry -> starts identical battle from enemy wire + merged party + seed.
  Turn 0 (controller=A): A chooses (local input) -> relays battle.input -> B injects it.
          B is grey-tinted ("A is choosing").
  Turn 1 (controller=B, T3): B chooses -> relays -> A injects. A is grey-tinted.
          (T2.5: controller stays A every turn; B always grey.)
  … alternate until faint order resolves; battle.end from initiator; both regroup.
```

---

## 11. Testing

- **Server unit:** team create/invite(online-only)/accept(TTL)/reject/leave/
  disband transitions; `team.lineup` validation; a team `battle.open` produces a
  `battle.start{mode:'team', enemy, partyWire}` to **all online members** with the
  correct interleaved order; `controller(turn)` schedule; `battle.input` relay to
  peers; desync abort path.
- **Web codec:** `enc.battleStart` with `enemy`+`mode`; TURN_BEGIN/STATEHASH
  decode.
- **e2e (demo mode):** three browsers form a team via `data-action` buttons, set
  lineups, then a scripted team battle: assert all three get `battle.start`, the
  grey veil toggles with `controller`, `battle.input` from the controller reaches
  the others, and `battle.end` regroups everyone. (This validates T1+T2 without a
  ROM.)
- **ROM (T2.5/T3):** `rom/ci-syntax-check.sh` green. **Real determinism must be
  proven on actual ROMs** — prototype with **two mGBA instances via the Lua
  bridge** (or two WASM tabs) on a fixed encounter, with the desync detector on,
  before calling it done. This is the acceptance gate for T2.5/T3.

---

## 12. Enhancements (post-v1)

1. **Trainer/gym team battles** — replicate the enemy trainer's full party + AI on
   every peer (ship the trainer party as wire mons; AI is deterministic given
   identical state + seed). Likely wants **R1** (link-battle piggyback).
2. **Double battles** (2 active player battlers) — natural fit for a 2-player team
   (each controls one active mon simultaneously instead of alternating). A
   different, arguably nicer, control model — worth prototyping.
3. **Persistent teams** across sessions (store in `WorldState`).
4. **Reconnect into an in-progress team battle.**
5. **R1 link-battle integration** to retire bespoke determinism risk.

---

## 13. Open decisions for the owner (surface before build)

- **D-Turn — DECIDED (owner, 2026-07):** **rotate-control-per-turn, hotseat**
  (turn 0 = initiator, then A→B→C→A…, decoupled from which Pokémon is active).
  Build §7.2/§7.4 to this. (Alternatives considered and rejected: control follows
  the active Pokémon's owner; double-battle simultaneous control. Double battles
  remain a possible §12.2 enhancement for 2-player teams only.)
- **D-Scope:** v1 = **wild single battles only**. OK to defer trainer/gym battles?
- **D-Absent members:** if a team member is **offline** when the encounter fires,
  they're simply excluded from that battle (only online members participate). OK?
- **D-Fallback:** is **T2.5** (teammates spectate the real shared battle; only the
  initiator commands) an acceptable shippable milestone if T3's per-turn rotation
  proves too costly?

---

## 14. Reality check for the builder
- T1 + T2 are ordinary full-stack work (server + web + demo adapter + tests) and
  should land smoothly. **Do these first and completely** — they deliver teams,
  invites, the builder GUI, and both players pulled into the battle with the
  spectator veil.
- **T2.5/T3 are real Gen-3 battle-engine engineering.** Budget for prototyping in
  isolation, expect determinism bugs, and build the **desync detector first**. Do
  not merge T2.5/T3 without a real two-instance ROM test passing. If it stalls,
  T2.5 is a coherent stopping point.
- Every protocol change: four implementations + `docs/PROTOCOL.md` + tests, one
  commit. ROM changes need a host **rebuild of `mba.gba`** to take effect.
