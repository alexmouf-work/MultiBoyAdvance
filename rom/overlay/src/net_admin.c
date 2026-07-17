// Console/terminal commands (NET_MSG_ADMIN) and the multiplayer quick start.
// These act only on the local game; the server decides who receives them.
//
// Admin commands mutate the save (party, bag, player name). They are QUEUED
// on receipt and applied only from a live overworld frame: applied anywhere
// else — the title screen, the intro, mid-battle — they either get destroyed
// by NewGameInitData() (the "new player has no starter" bug) or corrupt
// in-flight state.

#include <stddef.h>
#include <string.h>

#include "global.h"
#include "battle_setup.h"
#include "event_data.h"
#include "item.h"
#include "main.h"
#include "overworld.h"
#include "pokemon.h"
#include "script.h"
#include "script_pokemon_util.h"
#include "constants/characters.h"
#include "constants/flags.h"
#include "constants/heal_locations.h"
#include "constants/vars.h"
#include "net/mailbox.h"
#include "net/net.h"

#define RD_U16(p, i) ((u16)((p)[i] | ((p)[(i) + 1] << 8)))
#define RD_U32(p, i) \
    ((u32)((p)[i] | ((p)[(i) + 1] << 8) | ((u32)(p)[(i) + 2] << 16) | ((u32)(p)[(i) + 3] << 24)))

// vanilla convention: fixedIV > 31 means "roll random IVs"
#define ADMIN_RANDOM_IVS 32

// Pending commands, oldest first. Zero-init statics only (.data is discarded).
#define ADMIN_QUEUE_LEN 8
#define ADMIN_PAYLOAD_MAX 12
static u8 sQueue[ADMIN_QUEUE_LEN][ADMIN_PAYLOAD_MAX];
static u8 sQueueSize[ADMIN_QUEUE_LEN];
static u8 sQueueHead;
static u8 sQueueCount;

// net_incoming.c dispatch: enqueue only; NetAdminTick applies when safe.
void NetOnAdminCmd(const u8 *p, u8 len)
{
    u8 slot;

    if (len < 1 || len > ADMIN_PAYLOAD_MAX || sQueueCount >= ADMIN_QUEUE_LEN)
        return;
    slot = (sQueueHead + sQueueCount) % ADMIN_QUEUE_LEN;
    memcpy(sQueue[slot], p, len);
    sQueueSize[slot] = len;
    sQueueCount++;
}

static void AdminSetExp(struct Pokemon *mon, u32 exp)
{
    u16 species = GetMonData(mon, MON_DATA_SPECIES, NULL);
    u32 max = gExperienceTables[gSpeciesInfo[species].growthRate][MAX_LEVEL];

    if (exp > max)
        exp = max;
    SetMonData(mon, MON_DATA_EXP, &exp);
    CalculateMonStats(mon);
}

static bool8 AdminSlotValid(u8 slot)
{
    if (slot >= PARTY_SIZE)
        return FALSE;
    switch (GetMonData(&gPlayerParty[slot], MON_DATA_SPECIES_OR_EGG, NULL))
    {
    case SPECIES_NONE:
    case SPECIES_EGG:
        return FALSE;
    default:
        return TRUE;
    }
}

static void AdminGiveMon(u16 species, u8 level)
{
    struct Pokemon mon;

    CreateMon(&mon, species, level, ADMIN_RANDOM_IVS, FALSE, 0, OT_ID_PLAYER_ID, 0);
    GiveMonToPlayer(&mon);
    NetSendFullParty();
    NetSendPartySummary();
}

/** @returns FALSE if the command cannot run yet and should be retried. */
static bool8 AdminApply(const u8 *p, u8 len)
{
    switch (p[0])
    {
    case NET_ADMIN_GIVE_ITEM:
        if (len >= 5)
            AddBagItem(RD_U16(p, 1), RD_U16(p, 3));
        break;
    case NET_ADMIN_TAKE_ITEM:
        if (len >= 5)
            RemoveBagItem(RD_U16(p, 1), RD_U16(p, 3));
        break;
    case NET_ADMIN_GIVE_MON:
        if (len >= 4)
            AdminGiveMon(RD_U16(p, 1), p[3]);
        break;
    case NET_ADMIN_SET_LEVEL:
        if (len >= 3 && AdminSlotValid(p[1]) && p[2] >= 1 && p[2] <= MAX_LEVEL)
        {
            struct Pokemon *mon = &gPlayerParty[p[1]];
            u16 species = GetMonData(mon, MON_DATA_SPECIES, NULL);

            AdminSetExp(mon, gExperienceTables[gSpeciesInfo[species].growthRate][p[2]]);
        }
        break;
    case NET_ADMIN_GIVE_XP:
        if (len >= 6 && AdminSlotValid(p[1]))
        {
            struct Pokemon *mon = &gPlayerParty[p[1]];

            AdminSetExp(mon, GetMonData(mon, MON_DATA_EXP, NULL) + RD_U32(p, 2));
        }
        break;
    case NET_ADMIN_WILD_BATTLE:
        // Needs the field free (no script/dialog) — same context a script uses.
        if (len >= 4)
        {
            if (ArePlayerFieldControlsLocked())
                return FALSE;
            CreateScriptedWildMon(RD_U16(p, 1), p[3], 0);
            BattleSetup_StartScriptedWildBattle();
        }
        break;
    case NET_ADMIN_RESET_TRAINER:
        // Un-defeats the NPC; anything already awarded stays awarded.
        if (len >= 3 && RD_U16(p, 1) <= TRAINER_FLAGS_END - TRAINER_FLAGS_START)
            FlagClear(TRAINER_FLAGS_START + RD_U16(p, 1));
        break;
    case NET_ADMIN_SET_NAME:
        // Payload is already charmap-encoded by the server, EOS-padded.
        if (len >= 2)
        {
            u32 i, n = len - 1;

            if (n > PLAYER_NAME_LENGTH + 1)
                n = PLAYER_NAME_LENGTH + 1;
            for (i = 0; i < n; i++)
                gSaveBlock2Ptr->playerName[i] = p[1 + i];
            gSaveBlock2Ptr->playerName[PLAYER_NAME_LENGTH] = EOS;
        }
        break;
    case NET_ADMIN_TAKE_MON:
        // Trade give-away: remove the party mon at slot p[1] — but only if it
        // is still the species the server validated (a reshuffled party must
        // not cost the wrong Pokémon). Compact so no gap is left mid-party.
        if (len >= 4 && AdminSlotValid(p[1])
            && GetMonData(&gPlayerParty[p[1]], MON_DATA_SPECIES, NULL) == RD_U16(p, 2))
        {
            ZeroMonData(&gPlayerParty[p[1]]);
            CompactPartySlots();
            CalculatePlayerPartyCount();
            NetSendFullParty(); // re-report the post-trade party
            NetSendPartySummary();
        }
        break;
    }
    return TRUE;
}

// Resync must survive the new-game report burst (the out-ring WILL be full
// on that frame — 159 map flags get reported); retry until the write lands.
static bool8 sResyncPending;

// Called once per frame from NetTick.
void NetAdminTick(void)
{
    if (sResyncPending)
    {
        static const u8 sResync[2] = { NET_REQ_RESYNC, 0 };

        if (NetOutWrite(NET_MSG_REQUEST, sResync, sizeof(sResync)))
            sResyncPending = FALSE;
    }

    while (sQueueCount)
    {
        if (gMain.callback2 != CB2_Overworld)
            return; // not safe yet (title, intro, battle, menus)
        if (!AdminApply(sQueue[sQueueHead], sQueueSize[sQueueHead]))
            return; // front command wants a quieter frame; keep order
        NetLogNum("admin applied sub", sQueue[sQueueHead][0]);
        sQueueHead = (sQueueHead + 1) % ADMIN_QUEUE_LEN;
        sQueueCount--;
    }
}

// Multiplayer quick start. Called from NewGameInitData (new_game.c hook)
// right after EventScript_ResetAllMapFlags, so nothing here gets re-cleared.
// Mirrors the exact state the vanilla intro leaves after the Route 101
// Birch rescue + starter choice (Route101_EventScript_BirchsBag), minus the
// starter itself — that arrives from the web picker as ADMIN GIVE_MON.
// The player spawns in Oldale Town, outside the Pokémon Center (new_game.c
// hook warps there instead of the truck).
void NetQuickStart(void)
{
    // Fallback name; the server sends the registered one via ADMIN SET_NAME.
    static const u8 sDefaultName[PLAYER_NAME_LENGTH + 1] = {
        CHAR_P, CHAR_L, CHAR_A, CHAR_Y, CHAR_E, CHAR_R, EOS, EOS,
    };

    NetLog("quickstart: new game init");
    memcpy(gSaveBlock2Ptr->playerName, sDefaultName, sizeof(sDefaultName));
    gSaveBlock2Ptr->playerGender = 0;

    // Story machine: intro finished, town free to roam, Route 101 rescue done.
    VarSet(VAR_LITTLEROOT_INTRO_STATE, 7); // 7 = intro sequence finished
    VarSet(VAR_LITTLEROOT_TOWN_STATE, 4);  // 4 = running shoes given, mom inside
    VarSet(VAR_ROUTE101_STATE, 3);         // 3 = Birch rescued, triggers inert
    VarSet(VAR_BIRCH_LAB_STATE, 2);        // 2 = Birch back in his lab

    FlagSet(FLAG_RESCUED_BIRCH);
    FlagSet(FLAG_SYS_POKEMON_GET);
    FlagSet(FLAG_SYS_POKEDEX_GET);
    FlagSet(FLAG_ADVENTURE_STARTED);
    FlagSet(FLAG_SYS_B_DASH); // running shoes

    // Route 101 scene objects: hide the rescue Birch + Zigzagoon, and the
    // starter bag — clicking it would run the VANILLA starter chooser.
    FlagSet(FLAG_HIDE_ROUTE_101_BIRCH_ZIGZAGOON_BATTLE);
    FlagSet(FLAG_HIDE_ROUTE_101_ZIGZAGOON);
    FlagSet(FLAG_HIDE_ROUTE_101_BIRCH_STARTERS_BAG);
    FlagClear(FLAG_HIDE_LITTLEROOT_TOWN_BIRCHS_LAB_BIRCH); // Birch at his desk

    // Whiteouts respawn at the Pokémon Center we spawn beside.
    SetLastHealLocationWarp(HEAL_LOCATION_OLDALE_TOWN);

    // NewGameInitData wiped the world state the welcome replay applied at the
    // title screen; ask the server to send it (and our name) again. Deferred
    // to NetAdminTick — the ring is guaranteed full on this exact frame.
    sResyncPending = TRUE;
}
