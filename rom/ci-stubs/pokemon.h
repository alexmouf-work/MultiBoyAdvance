#pragma once
#include "global.h"
#define MON_DATA_SPECIES_OR_EGG 1
#define MON_DATA_LEVEL 2
#define MON_DATA_HP 3
#define MON_DATA_MAX_HP 4
#define SPECIES_NONE 0
#define SPECIES_EGG 0x8000
struct Pokemon { u8 x[100]; };
extern struct Pokemon gPlayerParty[PARTY_SIZE];
u32 GetMonData(struct Pokemon *mon, s32 field, u8 *data);
