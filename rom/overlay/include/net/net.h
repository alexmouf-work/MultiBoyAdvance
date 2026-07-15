// MultiBoyAdvance netcode — public hooks. Integration points: rom/README.md.
#ifndef GUARD_NET_NET_H
#define GUARD_NET_NET_H

#include "global.h"

// Call once per frame from the main loop (after ReadKeys() in AgbMain).
// Self-initializes on first call; safe to call before anything else runs.
void NetTick(void);

// event_data.c hooks — call at the end of FlagSet / VarSet.
void NetOnFlagSet(u16 flagId);
void NetOnVarSet(u16 varId, u16 value);

// battle_setup.c hook — call when a battle is being set up, before the
// transition starts, so peers get a join window.
void NetOnBattleOpen(u8 kind, u16 opponent);

// Party sync (net_battle.c): summaries + full 32-byte wire mons are sent
// automatically on change; call these to force a send.
void NetSendPartySummary(void);
void NetSendFullParty(void);

// battle_main.c hook — call at the top of
// CheckFocusPunch_ClearVarsBeforeTurnStarts to report finalized turn choices
// (emit-only; no effect on battle state).
void NetOnTurnFinalized(void);

// new_game.c hook (WarpToTruck) — multiplayer quick start: skip the intro,
// mark the story machine done, grant dex/running shoes, default name/gender.
// The starter Pokémon arrives via the web picker (NET_ADMIN_GIVE_MON).
void NetQuickStart(void);

// Ghost state for other players (net_overworld.c owns rendering in Phase 1).
struct NetGhost
{
    u8 active;
    u8 mapGroup;
    u8 mapNum;
    s16 x;
    s16 y;
    u8 facing;
    u8 moveState;
    u8 spriteId; // SPRITE_NONE when not rendered
};

#define NET_MAX_PLAYERS 8
extern struct NetGhost gNetGhosts[NET_MAX_PLAYERS];

// True while a host bridge is attached (drives online UI affordances).
bool8 NetIsOnline(void);

#endif // GUARD_NET_NET_H
