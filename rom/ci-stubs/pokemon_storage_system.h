// CI stub — matching subset of pokeemerald's include/pokemon_storage_system.h.
// Real sizeof(struct PokemonStorage) is ~33KB; the stub only needs to compile.
#pragma once
#include "global.h"
struct PokemonStorage { u8 raw[33744]; };
extern struct PokemonStorage *gPokemonStoragePtr;
