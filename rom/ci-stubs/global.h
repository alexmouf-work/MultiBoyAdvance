#ifndef GUARD_GLOBAL_H
#define GUARD_GLOBAL_H
typedef unsigned char u8; typedef unsigned short u16; typedef unsigned int u32;
typedef signed char s8; typedef signed short s16; typedef signed int s32;
typedef u8 bool8; typedef u16 bool16; typedef u32 bool32;
#define TRUE 1
#define FALSE 0
#define EWRAM_DATA
#define ALIGNED(n) __attribute__((aligned(n)))
#define STATIC_ASSERT(expr, name) _Static_assert(expr, #name)
#define PARTY_SIZE 6
#define OBJECT_EVENTS_COUNT 16
#define WARP_ID_NONE (-1)
struct Coords16 { s16 x, y; };
struct WarpData { s8 mapGroup, mapNum, warpId; s16 x, y; };
struct Location { u8 mapGroup, mapNum; };
struct SaveBlock1 { struct { u8 mapGroup, mapNum; } location; };
extern struct SaveBlock1 *gSaveBlock1Ptr;
#endif
