# Build plan — Player-to-player trading

Status: **BUILT** (v1 as specced: offer/accept/counter/reject, trade GUI,
PC overflow, /trade console path; §12 enhancements remain open). ROM side
compiles against the stubs — takes effect after the next host ROM rebuild.
Author: planning session (Opus). Builder: Claude Fable.
Companion: `docs/plans/TEAM-BATTLES.md`. Normative protocol: `docs/PROTOCOL.md`.

This plan is written to be built top-to-bottom. It names exact files, functions,
enum values, and message shapes, and it respects the standing rule (CLAUDE.md):
**a protocol change touches all four implementations (C overlay, JS bridge, Lua
bridge, Node server) + `docs/PROTOCOL.md` + tests, in one commit.**

---

## 1. What we're building (from the owner's spec)

- A trade is between **any two online players**, at **unlimited distance** (not
  the proximity give-item that already exists). Offline players can't be traded
  with.
- A trade can contain **Pokémon and/or items, in both directions**: "A offers
  {these} in exchange for {these} from B."
- Flow: **A proposes → B gets a top-of-screen notification "A has offered a
  trade" → B opens a custom trade GUI** showing "A offers …" and "in exchange
  for …", with three buttons:
  - **Accept** — completes the trade.
  - **Counter-offer** — rejects the current offer *and immediately* opens the
    trade editor for B to send a new offer back to A (pre-filled, editable).
  - **Reject** — cancels the trade.
- On accept, if a received Pokémon doesn't fit the party, it **goes to the PC**.

### Non-goals for v1 (call out, don't build)
- Trading items/Pokémon straight out of the **PC box** (v1 sources Pokémon from
  the **party** only; PC is a *destination* for overflow). PC-sourced trades are
  a defined enhancement in §12.
- Trade "locking"/simultaneous-ready UI like the official games. Our model is
  asymmetric offer→accept (simpler, matches the teleport handshake).
- Preserving **nickname / friendship / met-data** in v1 (see the fidelity note
  in §4.2 — v1 uses the existing 32-byte wire mon; §12 upgrades to full fidelity).

---

## 2. Design decisions (with rationale)

| # | Decision | Why |
|---|----------|-----|
| D1 | **Mirror the teleport handshake** (`world.js` `requestTeleport`/`tpRequests`/`TP_REQUEST_TTL_MS`), *not* pvp. | Teleport is the only existing offer that is **stored on the target with a TTL and verified at accept**. PvP trusts the `from` slot blindly (`world.js:342`) — unsafe for something that moves items/Pokémon. |
| D2 | **Server is the authority**; item + Pokémon moves are executed by **ADMIN-style commands routed to each ROM**. | The whole app already works this way (`net_admin.c` queues on receipt, applies on a safe overworld frame). No new trust model. |
| D3 | **Items** move via the existing `NET_ADMIN_GIVE_ITEM` / `NET_ADMIN_TAKE_ITEM` (subs 1/2). | Already implemented and stubbed (`AddBagItem`/`RemoveBagItem`). Zero ROM work for items. |
| D4 | **Pokémon** move as **32-byte wire mons** the server already holds. The server reads the giver's `client.fullMons[slot].b` (captured from `party.full`), delivers it to the receiver via a new host→game TLV, and tells the giver to delete that party slot via a new ADMIN sub. | The server *already* has every online player's full 32-byte party (the co-op battle system captures it). No ROM→server mon export round-trip is needed for v1. Receiving reuses `GiveMonToPlayer`, which **already routes to the PC when the party is full** (ROM agent confirmed). |
| D5 | **Counter-offer = reject + re-propose.** The client, on "counter", cancels the current trade and opens the editor pre-filled with the swapped terms (what A wanted becomes what B offers, and vice-versa), fully editable, then sends a fresh `trade.offer` from B→A. | Exactly the owner's spec. Keeps the server state machine to a single "one pending offer per direction" rule. |
| D6 | **One live offer per ordered pair at a time.** A→B and B→A are distinct; a counter-offer is a B→A offer. A new offer supersedes any prior pending offer from the same proposer to the same target. | Prevents duplicate/stale trade windows; simple to reason about. |
| D7 | Trade contents are **validated at accept time** against the giver's *current* party/bag, and the whole trade **aborts atomically-ish** if anything no longer holds (mon moved slots, item count dropped). | Party/bag can change between offer and accept. See §10 for the ordering that makes a half-trade impossible in the common case. |

**Fidelity caveat (D4):** the 32-byte wire mon carries personality, OT id,
species, held item, moves, level, ability slot, IVs, EVs — but **not** nickname,
friendship, current HP/status, or met data. For v1 that's acceptable (a traded
mon arrives healthy, un-nicknamed, like a fresh gift). §12 defines the
full-fidelity upgrade (opaque 80-byte `BoxPokemon` transfer) if the owner wants
nicknames/friendship preserved. **Confirm which tier to ship** (see §13).

---

## 3. End-to-end flow

```
A (proposer)                     Server                         B (target)
  |-- trade.offer --------------->|                                |
  |   {to, give:{...}, want:{...}}|-- validate A owns `give` -----> |
  |                               |   store pending on B (TTL)      |
  |                               |-- trade.req ------------------->|  "A has offered a trade"
  |                               |   {from, name, give, want}      |  toast → opens trade GUI
  |                               |                                 |
  |                               |<------------- trade.accept -----|  {from: A.slot}
  |                               |  match+TTL-check pending          |
  |                               |  re-validate BOTH sides' items/mons
  |                               |  EXECUTE (see §10):
  |<-- admin TAKE_ITEM / trade.take-mon (A gives) --|              |
  |<-- trade.deliver-mon / admin GIVE_ITEM (A gets)-|              |
  |                               |-- (mirror to B) -------------->|
  |<-- trade.done {ok,summary} ---|-- trade.done {ok,summary} ---->|
  |                               |                                 |
  |               (Reject)        |<------------- trade.reject -----|  {from: A.slot}
  |<-- trade.cancelled -----------|   drop pending                  |
  |                               |                                 |
  |            (Counter-offer)    |<------------- trade.reject -----|  then B sends a NEW
  |                               |   drop pending                  |  trade.offer B→A
```

---

## 4. Data model

### 4.1 Trade terms (wire shape, one side)
```jsonc
{
  "items": [ { "id": 13, "qty": 3 } ],   // bag items to hand over
  "mons":  [ { "slot": 2, "sp": 258 } ]  // party slots to hand over; sp = species snapshot for validation
}
```
- `id`/`qty` are u16-range; `slot` is a 0-based party index; `sp` is the species
  the proposer saw at offer time (used to detect a party reshuffle at accept).
- v1 caps: `items.length ≤ 8`, `mons.length ≤ 6` per side (validate on server).

### 4.2 Full offer message (client → server)
```jsonc
{ "t": "trade.offer", "to": 3,
  "give": { "items": [...], "mons": [...] },   // what the proposer gives
  "want": { "items": [...], "mons": [...] } }  // what the proposer asks from the target
```

### 4.3 Server-side pending record (mirror `tpRequests`)
Add to `Client` (declare in the constructor, `world.js:45`, alongside `tpRequests`):
```js
this.tradeOffers = new Map(); // proposerSlot -> { at: ms, give, want }
```
Store on the **target** client, keyed by proposer slot, exactly like teleport.
Add a module constant near `TP_REQUEST_TTL_MS` (`world.js:15`):
```js
const TRADE_OFFER_TTL_MS = 120_000; // 2 min to answer a trade
```

---

## 5. Protocol additions (the lockstep set)

### 5.1 New JSON wire messages

**Client → server** (add to `CLIENT_MESSAGES` in `server/src/protocol.js` with
required *numeric* fields; non-numeric parts validated in the handler):
| type | required numeric | notes |
|------|------------------|-------|
| `trade.offer`  | `['to']` | `give`/`want` objects validated in handler |
| `trade.accept` | `['from']` | |
| `trade.reject` | `['from']` | also used by "counter" (client rejects, then sends a fresh `trade.offer`) |

**Server → client** (never schema-validated; document in `docs/PROTOCOL.md §2.2`):
| type | fields | drives |
|------|--------|--------|
| `trade.req`       | `{from, name, give, want}` | the "A has offered a trade" toast + trade GUI contents |
| `trade.cancelled` | `{from, reason}` | proposer's UI when target rejects / offer expires / superseded |
| `trade.done`      | `{ok, with, summary}` | both parties: success/failure banner + log |

(Existing `trade.give` / `trade.recv` for the proximity one-way item hand-off
stay as-is; the new messages are additive.)

### 5.2 New EWRAM mailbox TLVs

Only **Pokémon** delivery needs new TLVs (items reuse ADMIN). Pick free values in
the correct ranges (game→host `0x01–0x7F`, host→game `0x80–0xFF`):

| dir | name | value | payload |
|-----|------|-------|---------|
| host→game | `NET_MSG_TRADE_DELIVER` | `0x92` | 32-byte wire mon (v1) — deliver a received Pokémon |

And one new **ADMIN sub-code** (host→game, fits the 12-byte admin payload):
| name | sub | payload | effect |
|------|-----|---------|--------|
| `NET_ADMIN_TAKE_MON` | `9` | `partySlot u8, species u16` | remove that party mon (verify species first), compact party |

> Why `TRADE_DELIVER` is its own TLV and not an ADMIN sub: the admin queue caps
> payloads at **12 bytes** (`ADMIN_PAYLOAD_MAX`), and a wire mon is 32. It needs
> its own inbound path + safe-frame apply (see §7).

### 5.3 File-by-file for the protocol layer
1. `docs/PROTOCOL.md` — add the three wire messages (§2.1/§2.2), the
   `NET_MSG_TRADE_DELIVER` row (§1.4 host→game), and the `NET_ADMIN_TAKE_MON`
   row (§1.6).
2. `rom/overlay/include/net/mailbox.h` — add `NET_MSG_TRADE_DELIVER = 0x92` to
   the host→game enum, and `NET_ADMIN_TAKE_MON = 9` to the `NET_ADMIN_*` enum.
3. `web/js/bridge/mailbox.js` — add `TRADE_DELIVER: 0x92` to `T`; add
   `enc.tradeDeliver(bytes32)` (returns the 32 bytes verbatim) and, if the bridge
   ever needs to read it, `dec`. Admin already encodes via `enc.admin`; extend it
   to handle `sub:'take_mon'` → `[9, slot, sp&0xff, sp>>8]`.
4. `rom/lua/mba-bridge.lua` — add `TRADE_DELIVER = 0x92` to `T`; add a
   `handleWire` branch for `m.t === 'trade.deliver'` → `queueIn(T.TRADE_DELIVER,
   bytes)`, and an `admin` encode branch for `take_mon`.
5. Tests — see §11.

---

## 6. Server changes (`server/src/`)

### 6.1 `world.js`
- Dispatch (`handle` switch, ~`world.js:186`): add
  ```js
  case 'trade.offer':  return this._onTradeOffer(client, msg);
  case 'trade.accept': return this._onTradeAccept(client, msg);
  case 'trade.reject': return this._onTradeReject(client, msg);
  ```
- `_onTradeOffer(client, msg)`:
  1. `const target = this.clients.get(msg.to)` — guard `!target || target === client`.
  2. `validateTerms(client, msg.give)` — the proposer must currently own everything
     in `give` (items via a bag snapshot if available; mons via
     `client.fullMons[slot]` species match). If not, `client.send({t:'error', …})`.
     (See §10 note on bag snapshots.)
  3. Normalize/clamp `give`/`want` (caps from §4.1).
  4. `target.tradeOffers.set(client.slot, { at: Date.now(), give, want })`
     (supersede any prior from this proposer).
  5. `target.send({ t:'trade.req', from: client.slot, name: client.name, give, want })`.
- `_onTradeReject(client, msg)`: read+delete `client.tradeOffers.get(msg.from)`;
  if it existed, notify the proposer `this.clients.get(msg.from)?.send({t:'trade.cancelled', from: client.slot, reason:'rejected'})`.
- `_onTradeAccept(client, msg)`:
  1. `const offer = client.tradeOffers.get(msg.from); client.tradeOffers.delete(msg.from);`
  2. Guard `offer` exists and `Date.now()-offer.at ≤ TRADE_OFFER_TTL_MS` (mirror
     `_onTpAccept`); resolve `const proposer = this.clients.get(msg.from)`; guard online.
  3. **Re-validate both directions now** (`offer.give` still owned by proposer;
     `offer.want` still owned by acceptor). On failure: `trade.done {ok:false}` to
     both, stop.
  4. **Execute** (`_executeTrade(proposer, acceptor, offer)`, §10).
  5. `trade.done {ok:true, summary}` to both.
- `removeClient` (`world.js:132`): drop any `tradeOffers` entries referencing the
  leaving slot, and any offers stored *on* the leaving client (GC — the codebase
  doesn't GC `tpRequests` today; do better here).

### 6.2 `_executeTrade(giver, taker, offer)` helper (new)
Server-mediated, ordered so a crash can't duplicate a Pokémon (take before give):
```
for each mon in offer.give.mons:  // A → B
    wire = giver.fullMons[mon.slot].b            // 32 bytes the server already holds
    verify wire species === mon.sp else abort
    giver.send(admin TAKE_MON {slot, sp})        // A loses it
    taker.send({t:'trade.deliver', b: wire})     // B gains it (party or PC)
for each item in offer.give.items:  giver.send(admin TAKE_ITEM); taker.send(admin GIVE_ITEM)
… mirror for offer.want (B → A) …
```
- The `admin`/`trade.deliver` messages are the existing/new server→client shapes;
  the bridges turn them into TLVs.
- **Ordering guarantees** (§10): all *takes* are queued before the matching
  *gives*, and both ROMs apply them only on a safe overworld frame, so the worst
  case from a mid-trade disconnect is "item/mon removed but delivery not applied"
  — logged, recoverable, never duplicated. Note this limitation honestly.

### 6.3 `commands.js` (console fallback + e2e lever)
Add `/trade <player> give mon <slot> [item <id> <qty>] for mon <slot> …` — or, to
keep parsing sane, a minimal `/trade <player>` that just opens the GUI targeting
that player. At minimum add `/trade <player> mon <mySlot> <theirSlot>` (swap one
mon each) so e2e and power users have a no-GUI path. Route through
`findTarget(world, me, word)` and the same `_onTradeOffer` logic.

---

## 7. ROM overlay changes (`rom/overlay/`)

Two new capabilities, both applied on **safe overworld frames** (never from the
inbound-dispatch path — this is the discipline `net_admin.c` already follows):

### 7.1 `NET_ADMIN_TAKE_MON` (sub 9) — extend `net_admin.c`
In `AdminApply`'s switch, add:
```c
case NET_ADMIN_TAKE_MON: { // p[1]=slot, p[2..3]=species (verify)
    u8 slot = p[1]; u16 sp = RD_U16(p, 2);
    if (slot < PARTY_SIZE
        && GetMonData(&gPlayerParty[slot], MON_DATA_SPECIES, NULL) == sp) {
        ZeroMonData(&gPlayerParty[slot]);
        CompactPartySlots();
        CalculatePlayerPartyCount();
        NetSendFullParty(); NetSendPartySummary(); // re-report post-trade party
    }
    break;
}
```
- New pokeemerald symbols needed → **add ci-stubs** in `rom/ci-stubs/pokemon.h`:
  `void ZeroMonData(struct Pokemon*);` and `void CompactPartySlots(void);` (both
  exist in the real decomp; only the stub subset must grow so
  `rom/ci-syntax-check.sh` still compiles). `RD_U16`, `GetMonData`,
  `CalculatePlayerPartyCount`, `NetSendFullParty`, `NetSendPartySummary`,
  `PARTY_SIZE` are already available.

### 7.2 `NET_MSG_TRADE_DELIVER` (0x92) — new `net_trade.c` + tick
- **Inbound routing:** in `net_incoming.c` `NetApplyIncoming()` switch, add
  `case NET_MSG_TRADE_DELIVER: NetOnTradeDeliver(payload, len); break;`.
- **New file `rom/overlay/src/net_trade.c`** (mirror `net_admin.c`'s queue+apply):
  ```c
  static EWRAM_DATA u8 sInbox[TRADE_INBOX][NET_MON_WIRE_SIZE];
  static EWRAM_DATA u8 sInboxCount;
  void NetOnTradeDeliver(const u8 *p, u8 len) {         // enqueue only
      if (len >= NET_MON_WIRE_SIZE && sInboxCount < TRADE_INBOX)
          memcpy(sInbox[sInboxCount++], p, NET_MON_WIRE_SIZE);
  }
  void NetTradeTick(void) {                              // apply on safe frames
      while (sInboxCount) {
          if (gMain.callback2 != CB2_Overworld) return; // party writes only in overworld
          struct Pokemon mon;
          MonFromWire(sInbox[0], &mon);                  // MonFromWire lives in net_battle.c
          GiveMonToPlayer(&mon);                         // party OR PC on overflow — free
          memmove(sInbox[0], sInbox[1], (--sInboxCount) * NET_MON_WIRE_SIZE);
          NetSendFullParty(); NetSendPartySummary();
      }
  }
  ```
  - `MonFromWire` is `static` in `net_battle.c`; either drop `static` and declare
    it in `net/net.h`, or move the wire codec into a shared `net_mon.c`. Prefer
    **declaring `MonToWire`/`MonFromWire` in `net.h`** and removing `static` (one
    small edit to `net_battle.c`).
  - `GiveMonToPlayer` is already stubbed/used. `TRADE_INBOX` = 6 is plenty.
- **Register the producer:** add `void NetTradeTick(void);` forward decl + the
  call in `NetTick()` (`net_mailbox.c`) *after* `NetApplyIncoming()` (so a
  same-frame delivery is queued before we try to drain), e.g. right after
  `NetAdminTick();`.
- **Header:** declare `NetOnTradeDeliver`/`NetTradeTick` in `net/net.h`.

### 7.3 What does *not* need ROM work
- Items (both directions) — `NET_ADMIN_GIVE_ITEM`/`TAKE_ITEM` already work.
- PC overflow on receive — `GiveMonToPlayer` handles it internally.

---

## 8. Web UI changes (`web/`)

### 8.1 Launch points
- **Roster button** (`ui.js #renderPlayers`, next to the existing `tp`/`pvp`
  buttons on each `#players li[data-slot]`): add
  `<button data-action="trade">trade</button>` wired to open the **trade editor**
  targeting that slot. Distance-independent, matching the spec.
- (Optional) also offer "Trade" on the `#proximity` pill when someone is adjacent.

### 8.2 The trade GUI (mirror `#starter-modal` / `.starter-card`)
New `#trade-modal` inside `#gamewrap`, `hidden` by default, `z-index: 85`
(above toasts 70 / proximity 65, below the boot overlay 90), with an explicit
`#trade-modal[hidden]{display:none}` rule (every modal here re-declares it).
Two visual modes in one modal:
- **Review mode** (target received an offer): renders "**{name} offers**" (a list
  of item/mon chips from `trade.req.give`) and "**in exchange for**" (from
  `trade.req.want`), then three buttons:
  - `data-action="trade-accept"` → `socket.send({t:'trade.accept', from})`, hide.
  - `data-action="trade-counter"` → `socket.send({t:'trade.reject', from})` then
    switch this same modal into **Edit mode** pre-filled with the swapped terms
    (their `want` becomes my `give`, their `give` becomes my `want`), targeting the
    original proposer.
  - `data-action="trade-reject"` → `socket.send({t:'trade.reject', from})`, hide.
- **Edit mode** (I'm composing an offer to a target): two columns — "**You give**"
  and "**You want**" — each a list the player fills from:
  - **their own party** (from the party summaries the UI already receives via
    `party`/`bridge.onParty`; render species + level chips, pick slots), and
  - **items** (a simple `id` + `qty` numeric input row, like `#prox-item`/
    `#prox-qty`; a curated item picker is a nice-to-have, not required for v1).
  - "You want" from the target is composed **blind** (you don't see their bag);
    it's a request. That's fine and matches the spec's "in exchange for …".
  - Send button → `socket.send({t:'trade.offer', to, give, want})`, hide, toast
    "offer sent".

### 8.3 Notifications (mirror `#toast`)
Handle in `ui.js #wire()`:
- `s.on('trade.req', m => this.#toast(`🔁 ${m.name} has offered a trade`, {
    action:'trade-open', label:'Open', ttl: 115000,
    onAction:()=>this.#openTradeReview(m) }))` — the toast's button opens the
  review modal. (Matches "click the notification to open the trade menu.")
- `s.on('trade.cancelled', m => this.#toast('trade cancelled', {ttl:6000}))` + log.
- `s.on('trade.done', m => this.#toast(m.ok ? '✅ trade complete' : '⚠️ trade failed', {ttl:6000}))` + log.

### 8.4 Bridge (`web/js/bridge/bridge.js`)
The bridge already turns `admin` messages into ADMIN TLVs — extend `enc.admin`
for `take_mon`. Add a handler for the new mon delivery:
```js
s.on('trade.deliver', (m) => this.#queueIn(T.TRADE_DELIVER, enc.tradeDeliver(m.b)));
```
where `m.b` is the 32-int wire array (server forwards the giver's `fullMons` bytes).

### 8.5 Mobile / touch
- Parent the modal inside `#gamewrap` so it rides the fixed mobile frame; in
  portrait `mobile-overlay` the frame is rotated 90° and children inherit it —
  acceptable (matches the game). Keep the layout a simple scrollable column so it
  survives the rotated aspect.
- Numeric inputs (`type="number"`) don't trigger the emulator's keyboard-capture
  suspend (that selector is `input[type=text], input:not([type]), textarea`). If
  any free-text input is added, extend that selector in `main.js` (~296) so keys
  don't leak to the ROM.

### 8.6 `window.mba` / e2e hooks
Expose enough on `window.mba.ui` (e.g. `ui.tradeState`) and rely on
`data-action` DOM hooks (`trade`, `trade-accept`, `trade-counter`, `trade-reject`,
`trade-open`) so the e2e can drive a full trade in demo mode (§11).

---

## 9. Demo adapter (`web/js/emu/demo-adapter.js`)
So the e2e can exercise trades without a ROM, teach the demo adapter to react to
the trade mailbox operations: on a `TRADE_DELIVER`/`admin take_mon`, mutate its
in-memory party and push an `events` entry (`{t:'trade.applied', …}`), mirroring
how it already records battle/admin events. This is what the e2e asserts on.

---

## 10. Correctness, ordering, atomicity

- **Validation at accept, not just offer.** Re-check ownership of both sides at
  `trade.accept` (party species by slot via `fullMons`; items via the giver's
  latest bag snapshot). If a mon moved slots or an item count dropped, **abort the
  whole trade** and send `trade.done {ok:false}` to both. No partial application.
- **Bag snapshots.** The server does not currently track bag contents (only party
  summaries). For item validation, either (a) accept items optimistically and let
  `RemoveBagItem` no-op if absent (lossy but safe — B just doesn't receive what A
  didn't have), or (b) add a lightweight `bag` summary report (a new small
  game→host TLV the overlay emits on bag change). **v1: option (a)** with a logged
  warning; option (b) is a §12 enhancement.
- **Take-before-give ordering.** For each transferred mon/item, queue the *take*
  (from the giver) before the *give* (to the taker). Because both ROMs apply these
  only on safe overworld frames and the server sends them in one burst, the only
  failure window is a disconnect mid-burst, whose worst case is a *lost* mon/item
  (removed, not delivered) — never a *duplicated* one. Log every executed leg so a
  lost item is diagnosable. State this limitation in `docs/PROTOCOL.md`.
- **TTL + supersede.** Pending offers expire at `TRADE_OFFER_TTL_MS` (checked
  lazily at accept, like teleport) and are superseded by a newer offer from the
  same proposer. GC on disconnect (unlike `tpRequests`).

---

## 11. Testing

- **Server unit (`server/test/`, node:test):**
  - `trade.offer` stores a pending record on the target and emits `trade.req`.
  - `trade.reject` clears it and notifies the proposer (`trade.cancelled`).
  - `trade.accept` with a valid offer emits the correct sequence of
    `admin`/`trade.deliver` messages to both clients (assert the exact envelopes),
    and `trade.done {ok:true}`; mons taken-before-given.
  - Accept after TTL, or after the offered mon changed slots, → `trade.done
    {ok:false}`, no admin messages.
  - Offline target / self-target rejected.
- **Web codec (`web/test/`):** `enc.tradeDeliver`, `enc.admin` `take_mon` encode
  to the exact bytes; round-trip against `dec` if added.
- **e2e (`e2e/test/`, Playwright, demo mode):** two browsers; A opens the trade
  editor from the roster (`button[data-action="trade"]`), offers a mon, B gets the
  `trade.req` toast, opens review, hits **counter** (assert the editor reopens
  pre-filled and a new `trade.offer` goes A-ward), then A accepts; assert both
  demo adapters' parties changed and both saw `trade.done {ok:true}`. Also cover a
  plain accept and a reject.
- **ROM:** `rom/ci-syntax-check.sh` must stay green (new `net_trade.c`, the new
  stubs, and the `net.h`-exported `MonFromWire`). Real in-ROM verification is a
  host build step (see §14).

---

## 12. Enhancements (post-v1, defined but not built)

1. **Full-fidelity mon transfer.** Replace the 32-byte wire with an opaque
   **80-byte `BoxPokemon`** blob: a new game→host `NET_MSG_TRADE_EXPORT` (the
   giver's ROM serializes the exact mon and removes it) + host→game
   `NET_MSG_TRADE_DELIVER` carrying the 80 bytes; the server just routes the
   opaque blob. Preserves nickname/friendship/met-data. Needs `GetBoxMonData`/
   `SetBoxMonData`-style stubs. This removes D4's fidelity caveat.
2. **PC-sourced trades.** Let a player offer a Pokémon out of a box, not just the
   party. Needs PC read/remove stubs (`GetBoxMonData`, a box-slot delete) — the
   ROM agent noted these aren't stubbed yet.
3. **Bag-summary TLV** for exact item validation (option (b) in §10).
4. **Trade history / log** panel in the sidebar.

---

## 13. Open decisions for the owner (surface before/at build)

1. **Mon fidelity tier** — ship v1's 32-byte wire (no nickname/friendship, less
   ROM work) or go straight to the 80-byte full-fidelity transfer (§12.1)?
   *Recommendation: v1 wire first; upgrade later.*
2. **"You want" visibility** — when composing an offer, the proposer can't see the
   target's bag/party in v1 (they request blind by species/item id). Acceptable?
   *(A "browse their party" step would need the target's `fullMons` shared to the
   proposer — easy to add since the server already has it, but it leaks roster
   info; hence opt-in.)*
3. **Console/e2e path** — is a minimal `/trade` command wanted for power users, or
   GUI-only?

---

## 14. Deploy / verify notes
- The `net_*.c` + stub + `mailbox.h` changes are **ROM-side**: they take effect
  only after the host **rebuilds `mba.gba`** (`rom/setup.sh` re-applies hooks and
  rebuilds) and redeploys it. The server + web + Lua changes go live on the next
  server/web deploy.
- Keep the four implementations in lockstep in a **single commit** per the
  standing rule; run `server` + `web` + `e2e` suites and `rom/ci-syntax-check.sh`
  before committing.
