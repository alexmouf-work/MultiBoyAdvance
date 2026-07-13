// CI stub — matching subset of pokeemerald's include/pokemon.h contract.
#pragma once
#include "global.h"

#define MAX_MON_MOVES 4
#define NUM_STATS 6

#define SPECIES_NONE 0
#define SPECIES_EGG 0x8000

#define OT_ID_PLAYER_ID 0
#define OT_ID_PRESET 1
#define OT_ID_RANDOM_NO_SHINY 2

// Same relative layout as the real enum: MOVE1..MOVE4, PP1..PP4, the six EVs,
// and the six IVs are contiguous runs (the overlay indexes off the run heads).
enum {
    MON_DATA_PERSONALITY,
    MON_DATA_OT_ID,
    MON_DATA_SPECIES,
    MON_DATA_SPECIES_OR_EGG,
    MON_DATA_HELD_ITEM,
    MON_DATA_MOVE1,
    MON_DATA_MOVE2,
    MON_DATA_MOVE3,
    MON_DATA_MOVE4,
    MON_DATA_PP1,
    MON_DATA_PP2,
    MON_DATA_PP3,
    MON_DATA_PP4,
    MON_DATA_HP_EV,
    MON_DATA_ATK_EV,
    MON_DATA_DEF_EV,
    MON_DATA_SPEED_EV,
    MON_DATA_SPATK_EV,
    MON_DATA_SPDEF_EV,
    MON_DATA_HP_IV,
    MON_DATA_ATK_IV,
    MON_DATA_DEF_IV,
    MON_DATA_SPEED_IV,
    MON_DATA_SPATK_IV,
    MON_DATA_SPDEF_IV,
    MON_DATA_ABILITY_NUM,
    MON_DATA_LEVEL,
    MON_DATA_HP,
    MON_DATA_MAX_HP,
};

struct Pokemon { u8 raw[100]; };
extern struct Pokemon gPlayerParty[PARTY_SIZE];

u32 GetMonData(struct Pokemon *mon, s32 field, u8 *data);
void SetMonData(struct Pokemon *mon, s32 field, const void *dataArg);
void CreateMon(struct Pokemon *mon, u16 species, u8 level, u8 fixedIV, u8 hasFixedPersonality, u32 fixedPersonality, u8 otIdType, u32 fixedOtId);
void CalculateMonStats(struct Pokemon *mon);
void ZeroPlayerPartyMons(void);
u8 CalculatePlayerPartyCount(void);
