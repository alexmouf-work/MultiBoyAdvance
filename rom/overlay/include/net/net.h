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

// save.c hook — call from TrySavingData's success path. Reports the save so
// bridges can persist the .sav (browser + server). Autosave: net_save.c.
void NetOnGameSaved(void);

// new_game.c hook (end of NewGameInitData) — multiplayer quick start: the
// whole intro is skipped (main_menu.c jumps straight to CB2_NewGame, the
// truck warp is redirected to Oldale Town outside the Pokémon Center), and
// this marks the story machine post-rescue: dex, running shoes, Route 101
// scene done. The starter arrives via the web picker (NET_ADMIN_GIVE_MON);
// the player's registered name via NET_ADMIN_SET_NAME after the resync.
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

// Debug feed (NET_MSG_LOG): short ASCII lines surfaced in the bridge's debug
// panel — the in-game "traceback". Cheap enough to leave in release builds.
void NetLog(const char *msg);
void NetLogNum(const char *tag, u32 value); // emits "tag=HEX"

#endif // GUARD_NET_NET_H
