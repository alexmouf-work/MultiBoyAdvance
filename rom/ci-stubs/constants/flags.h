// CI stub — matching subset of pokeemerald's include/constants/flags.h.
#pragma once
#define FLAG_ADVENTURE_STARTED 0x74
#define TRAINER_FLAGS_START    0x500
#define TRAINER_FLAGS_END      0x85F
#define SYSTEM_FLAGS           (TRAINER_FLAGS_END + 1)
#define FLAG_SYS_POKEMON_GET   (SYSTEM_FLAGS + 0x0)
#define FLAG_SYS_POKEDEX_GET   (SYSTEM_FLAGS + 0x1)
#define FLAG_SYS_B_DASH        (SYSTEM_FLAGS + 0x60)
