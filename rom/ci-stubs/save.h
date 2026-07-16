// CI stub — matching subset of pokeemerald's include/save.h contract.
#pragma once
#include "global.h"
#define SAVE_NORMAL 0
u8 TrySavingData(u8 saveType);
extern u16 gLastWrittenSector;
extern u32 gSaveCounter;
