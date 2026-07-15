// Console/terminal commands (NET_MSG_ADMIN) and the multiplayer quick start.
// These act only on the local game; the server decides who receives them.

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
#include "constants/vars.h"
#include "net/mailbox.h"
#include "net/net.h"

#define RD_U16(p, i) ((u16)((p)[i] | ((p)[(i) + 1] << 8)))
#define RD_U32(p, i) \
    ((u32)((p)[i] | ((p)[(i) + 1] << 8) | ((u32)(p)[(i) + 2] << 16) | ((u32)(p)[(i) + 3] << 24)))

// vanilla convention: fixedIV > 31 means "roll random IVs"
#define ADMIN_RANDOM_IVS 32

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

void NetOnAdminCmd(const u8 *p, u8 len)
{
    if (len < 1)
        return;

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
        // Only from a quiet overworld frame — same context a script would use.
        if (len >= 4 && gMain.callback2 == CB2_Overworld && !ArePlayerFieldControlsLocked())
        {
            CreateScriptedWildMon(RD_U16(p, 1), p[3], 0);
            BattleSetup_StartScriptedWildBattle();
        }
        break;
    case NET_ADMIN_RESET_TRAINER:
        // Un-defeats the NPC; anything already awarded stays awarded.
        if (len >= 3 && RD_U16(p, 1) <= TRAINER_FLAGS_END - TRAINER_FLAGS_START)
            FlagClear(TRAINER_FLAGS_START + RD_U16(p, 1));
        break;
    }
}

// Called from WarpToTruck (new_game.c) in place of the truck intro: the new
// game starts in Littleroot, story intro already complete, ready to battle.
void NetQuickStart(void)
{
    static const u8 sDefaultName[PLAYER_NAME_LENGTH + 1] = {
        CHAR_P, CHAR_L, CHAR_A, CHAR_Y, CHAR_E, CHAR_R, EOS, EOS,
    };

    memcpy(gSaveBlock2Ptr->playerName, sDefaultName, sizeof(sDefaultName));
    gSaveBlock2Ptr->playerGender = 0;

    VarSet(VAR_LITTLEROOT_INTRO_STATE, 7); // 7 = intro machine finished
    FlagSet(FLAG_SYS_POKEMON_GET);
    FlagSet(FLAG_SYS_POKEDEX_GET);
    FlagSet(FLAG_ADVENTURE_STARTED);
    FlagSet(FLAG_SYS_B_DASH); // running shoes
}
