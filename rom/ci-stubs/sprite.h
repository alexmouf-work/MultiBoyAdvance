// CI stub — matching subset of pokeemerald's include/sprite.h contract.
#pragma once
#include "global.h"

#define MAX_SPRITES 64
#define SPRITE_NONE 0xFF

struct OamData { u16 paletteNum:4; u16 priority:2; };
struct Sprite
{
    struct OamData oam;
    s16 x, y;
    s8 centerToCornerVecX, centerToCornerVecY;
    bool8 coordOffsetEnabled;
};
extern struct Sprite gSprites[MAX_SPRITES + 1];

void SpriteCallbackDummy(struct Sprite *sprite);
void DestroySprite(struct Sprite *sprite);
void StartSpriteAnim(struct Sprite *sprite, u8 animNum);
