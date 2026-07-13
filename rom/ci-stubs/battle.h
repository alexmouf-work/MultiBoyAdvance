// CI stub — matching subset of pokeemerald's include/battle.h contract.
#pragma once
#include "global.h"

#define MAX_BATTLERS_COUNT 4
#define B_SIDE_PLAYER 0
#define B_SIDE_OPPONENT 1

extern u8 gBattlersCount;
extern u8 gChosenActionByBattler[MAX_BATTLERS_COUNT];
extern u16 gChosenMoveByBattler[MAX_BATTLERS_COUNT];
