// Mailbox core: the EWRAM struct, ring primitives, per-frame pump.
// Layout contract: docs/PROTOCOL.md §1 / include/net/mailbox.h.

#include "global.h"
#include "net/mailbox.h"
#include "net/net.h"

EWRAM_DATA ALIGNED(4) volatile struct NetMailbox gNetMailbox = {0};

static bool8 sInitialized = FALSE;

// Defined in the sibling net_*.c modules; internal to the overlay.
void NetOverworldTick(void);
void NetApplyIncoming(void);
void NetWarpTick(void);
void NetBattleTick(void);
void NetAdminTick(void);
void NetTradeTick(void);
void NetFlagsTick(void);
void NetSaveTick(void);

static void NetInit(void)
{
    volatile struct NetMailbox *mb = &gNetMailbox;
    u32 i;

    // Zero everything but publish the magic LAST so a scanning bridge can
    // never attach to a half-initialized struct.
    mb->version = NET_PROTO_VERSION;
    mb->gameState = NET_GSTATE_BOOT;
    mb->frameCounter = 0;
    mb->playerSlot = 0xFF;
    mb->hostAttached = 0;
    for (i = 0; i < sizeof(mb->reserved); i++)
        mb->reserved[i] = 0;
    mb->out.head = mb->out.tail = 0;
    mb->in.head = mb->in.tail = 0;

    mb->magic[1] = 'B';
    mb->magic[2] = 'A';
    mb->magic[3] = '0';
    mb->magic[0] = 'M';

    sInitialized = TRUE;

    {
        u8 v = NET_PROTO_VERSION;
        NetOutWrite(NET_MSG_HELLO, &v, 1);
    }
}

static u16 RingFree(volatile struct NetRing *r)
{
    return NET_RING_SIZE - 1 - (u16)((r->head - r->tail + NET_RING_SIZE) % NET_RING_SIZE);
}

bool8 NetOutWrite(u8 type, const u8 *payload, u8 len)
{
    volatile struct NetRing *r = &gNetMailbox.out;
    u16 head = r->head;
    u32 i;

    if ((u16)(2 + len) > RingFree(r))
        return FALSE;

    r->buf[head] = type;
    r->buf[(head + 1) % NET_RING_SIZE] = len;
    for (i = 0; i < len; i++)
        r->buf[(head + 2 + i) % NET_RING_SIZE] = payload[i];
    // Publish after the record is fully written (record-atomic).
    r->head = (head + 2 + len) % NET_RING_SIZE;
    return TRUE;
}

bool8 NetInRead(u8 *type, u8 *payload, u8 *len)
{
    volatile struct NetRing *r = &gNetMailbox.in;
    u16 tail = r->tail;
    u16 head = r->head;
    u32 i;

    if (tail == head)
        return FALSE;

    *type = r->buf[tail];
    *len = r->buf[(tail + 1) % NET_RING_SIZE];
    for (i = 0; i < *len; i++)
        payload[i] = r->buf[(tail + 2 + i) % NET_RING_SIZE];
    r->tail = (tail + 2 + *len) % NET_RING_SIZE;
    return TRUE;
}

bool8 NetIsOnline(void)
{
    return sInitialized && gNetMailbox.hostAttached != 0;
}

// ---- debug feed -------------------------------------------------------------
// Short ASCII lines for the bridge's debug panel. Dropped silently when the
// ring is full — logging must never disturb the game.

#define NET_LOG_MAX 48

void NetLog(const char *msg)
{
    u8 p[NET_LOG_MAX];
    u32 n = 0;

    if (!sInitialized)
        return;
    while (msg[n] != '\0' && n < NET_LOG_MAX)
    {
        p[n] = (u8)msg[n];
        n++;
    }
    NetOutWrite(NET_MSG_LOG, p, n);
}

void NetLogNum(const char *tag, u32 value)
{
    u8 p[NET_LOG_MAX];
    u32 n = 0;
    s32 shift;

    if (!sInitialized)
        return;
    while (tag[n] != '\0' && n < NET_LOG_MAX - 10)
    {
        p[n] = (u8)tag[n];
        n++;
    }
    p[n++] = '=';
    for (shift = 28; shift >= 0; shift -= 4)
        p[n++] = "0123456789ABCDEF"[(value >> shift) & 0xF];
    NetOutWrite(NET_MSG_LOG, p, n);
}

void NetTick(void)
{
    if (!sInitialized)
        NetInit();

    gNetMailbox.frameCounter++;

    // Consume everything the bridge queued for us since last frame.
    NetApplyIncoming();

    // Producers: presence, party change detection, pending warp application,
    // queued admin commands (applied only on safe overworld frames), and the
    // dirty flag/var report drain (survives ring-full bursts).
    NetOverworldTick();
    NetBattleTick();
    NetWarpTick();
    NetAdminTick();
    NetTradeTick();
    NetFlagsTick();
    NetSaveTick();
}
