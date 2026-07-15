#pragma once
#include "global.h"
struct PlayerAvatar { u8 objectEventId; };
extern struct PlayerAvatar gPlayerAvatar;
u8 GetPlayerFacingDirection(void);
void StopPlayerAvatar(void);
