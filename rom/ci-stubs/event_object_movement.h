// CI stub — matching subset of pokeemerald's include/event_object_movement.h.
#pragma once
#include "global.h"
#include "sprite.h"

struct ObjectEvent { struct Coords16 currentCoords; u8 facingDirection; };
extern struct ObjectEvent gObjectEvents[OBJECT_EVENTS_COUNT];

u8 CreateObjectGraphicsSprite(u16 graphicsId, void (*callback)(struct Sprite *), s16 x, s16 y, u8 subpriority);
void SetSpritePosToMapCoords(s16 mapX, s16 mapY, s16 *destX, s16 *destY);
u8 GetFaceDirectionAnimNum(u8 direction);
