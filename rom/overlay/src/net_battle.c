// Co-op / PvP battle netcode.
//
// Implemented: encounter reporting (join-window trigger), session bookkeeping
// from BATTLE_CMD START/INPUT/END, party summaries + full 32-byte wire-mon
// transfer for the server's merge, merged-party injection into gPlayerParty
// (with backup/restore around the session), and shared-seed RNG at battle
// start. Remaining Phase-3 work: feeding relayed TURN_INPUTs into the battle
// controllers and bag scoping. See docs/ROADMAP.md.

#include <stddef.h>
#include <string.h>

#include "global.h"
#include "battle.h"
#include "battle_anim.h" // GetBattlerSide
#include "battle_setup.h" // BattleSetup_StartScriptedWildBattle (team peer entry)
#include "main.h"
#include "overworld.h"
#include "pokemon.h"
#include "random.h"
#include "script.h" // ArePlayerFieldControlsLocked
#include "script_pokemon_util.h" // CreateScriptedWildMon
#include "net/mailbox.h"
#include "net/net.h"

struct NetBattleSession
{
    bool8 active;
    u32 seed;
    u8 playerCount;
    u8 order[4];
    u8 mode; // NET_BMODE_*
    u8 turnNo;
    u8 init; // team: slot whose encounter opened the battle (turn 0's controller)
};

static struct NetBattleSession sSession;

// Team mode (docs/plans/TEAM-BATTLES.md T2.5): whether THIS game opened the
// encounter, the enemy shipped in the extended START, and a queued peer entry
// (applied only from a quiet overworld frame, like every world mutation).
static bool8 sIsInitiator;
static EWRAM_DATA u8 sEnemyWire[NET_MON_WIRE_SIZE] = {0};
static bool8 sHaveEnemy;
static bool8 sPendingPeerEntry;

// Merged party staged by BATTLE_CMD PARTY, applied at START, undone at END.
static EWRAM_DATA u8 sPendingParty[1 + PARTY_SIZE * NET_MON_WIRE_SIZE] = {0};
static EWRAM_DATA struct Pokemon sPartyBackup[PARTY_SIZE] = {0};
static bool8 sHavePendingParty;
static bool8 sPartyInjected;
static bool8 sSentInitialParty;
static u16 sLastPartyChecksum;
static u8 sPartyResendDelay;

#define RD_U16(p, i) ((u16)((p)[i] | ((p)[(i) + 1] << 8)))
#define RD_U32(p, i) \
    ((u32)((p)[i] | ((p)[(i) + 1] << 8) | ((u32)(p)[(i) + 2] << 16) | ((u32)(p)[(i) + 3] << 24)))

static void WR_U16(u8 *p, u32 i, u16 v)
{
    p[i] = v & 0xFF;
    p[i + 1] = v >> 8;
}

static void WR_U32(u8 *p, u32 i, u32 v)
{
    p[i] = v & 0xFF;
    p[i + 1] = (v >> 8) & 0xFF;
    p[i + 2] = (v >> 16) & 0xFF;
    p[i + 3] = (v >> 24) & 0xFF;
}

void NetOnBattleOpen(u8 kind, u16 opponent)
{
    u8 p[4 + NET_MON_WIRE_SIZE];
    u8 len = 4;

    if (!NetIsOnline())
        return;
    p[0] = NET_BSUB_START_OR_ENCOUNTER;
    p[1] = kind;
    p[2] = opponent & 0xFF;
    p[3] = opponent >> 8;
    // Wild encounters ship the EXACT enemy so team peers can enter the
    // identical battle (each ROM rolling its own would desync instantly).
    if (kind == 0 && GetMonData(&gEnemyParty[0], MON_DATA_SPECIES, NULL) != SPECIES_NONE)
    {
        MonToWire(&gEnemyParty[0], &p[4]);
        len += NET_MON_WIRE_SIZE;
    }
    sIsInitiator = TRUE; // this game's own battle is already starting
    NetOutWrite(NET_MSG_BATTLE_EVENT, p, len);
}

// ---- 32-byte wire-mon codec (layout: mailbox.h / docs/PROTOCOL.md §1.5) ----
// Exported via net/net.h: net_trade.c reuses it to apply traded Pokémon.

void MonToWire(struct Pokemon *mon, u8 *w)
{
    u32 ivs = 0;
    u32 i;

    WR_U32(w, 0, GetMonData(mon, MON_DATA_PERSONALITY, NULL));
    WR_U32(w, 4, GetMonData(mon, MON_DATA_OT_ID, NULL));
    WR_U16(w, 8, GetMonData(mon, MON_DATA_SPECIES, NULL));
    WR_U16(w, 10, GetMonData(mon, MON_DATA_HELD_ITEM, NULL));
    for (i = 0; i < MAX_MON_MOVES; i++)
        WR_U16(w, 12 + i * 2, GetMonData(mon, MON_DATA_MOVE1 + i, NULL));
    w[20] = GetMonData(mon, MON_DATA_LEVEL, NULL);
    w[21] = GetMonData(mon, MON_DATA_ABILITY_NUM, NULL);
    for (i = 0; i < NUM_STATS; i++)
        ivs |= (GetMonData(mon, MON_DATA_HP_IV + i, NULL) & 0x1F) << (i * 5);
    WR_U32(w, 22, ivs);
    for (i = 0; i < NUM_STATS; i++)
        w[26 + i] = GetMonData(mon, MON_DATA_HP_EV + i, NULL);
}

void MonFromWire(const u8 *w, struct Pokemon *mon)
{
    u32 personality = RD_U32(w, 0);
    u32 otId = RD_U32(w, 4);
    u16 species = RD_U16(w, 8);
    u16 heldItem = RD_U16(w, 10);
    u32 ivs = RD_U32(w, 22);
    u16 maxHp;
    u32 i;

    CreateMon(mon, species, w[20], 0, TRUE, personality, OT_ID_PRESET, otId);
    SetMonData(mon, MON_DATA_HELD_ITEM, &heldItem);
    SetMonData(mon, MON_DATA_ABILITY_NUM, &w[21]);
    for (i = 0; i < MAX_MON_MOVES; i++)
    {
        u16 move = RD_U16(w, 12 + i * 2);
        SetMonData(mon, MON_DATA_MOVE1 + i, &move);
    }
    for (i = 0; i < NUM_STATS; i++)
    {
        u8 iv = (ivs >> (i * 5)) & 0x1F;
        SetMonData(mon, MON_DATA_HP_IV + i, &iv);
        SetMonData(mon, MON_DATA_HP_EV + i, &w[26 + i]);
    }
    CalculateMonStats(mon);
    maxHp = GetMonData(mon, MON_DATA_MAX_HP, NULL);
    SetMonData(mon, MON_DATA_HP, &maxHp);
}

// ---- merged-party injection --------------------------------------------------

static void InjectPendingParty(void)
{
    u8 count = sPendingParty[0];
    u32 i;

    if (!sHavePendingParty || count == 0 || count > PARTY_SIZE)
        return;
    if (!sPartyInjected)
        memcpy(sPartyBackup, gPlayerParty, sizeof(sPartyBackup));

    ZeroPlayerPartyMons();
    for (i = 0; i < count; i++)
        MonFromWire(&sPendingParty[1 + i * NET_MON_WIRE_SIZE], &gPlayerParty[i]);
    CalculatePlayerPartyCount();
    sPartyInjected = TRUE;
    sHavePendingParty = FALSE;
}

static void RestorePartyIfInjected(void)
{
    if (!sPartyInjected)
        return;
    memcpy(gPlayerParty, sPartyBackup, sizeof(sPartyBackup));
    CalculatePlayerPartyCount();
    sPartyInjected = FALSE;
}

void NetSendFullParty(void)
{
    u8 p[1 + PARTY_SIZE * NET_MON_WIRE_SIZE];
    u8 count = 0;
    u32 i;

    if (!NetIsOnline() || sPartyInjected)
        return;
    for (i = 0; i < PARTY_SIZE; i++)
    {
        u16 species = GetMonData(&gPlayerParty[i], MON_DATA_SPECIES_OR_EGG, NULL);

        if (species == SPECIES_NONE || species == SPECIES_EGG)
            continue;
        MonToWire(&gPlayerParty[i], &p[1 + count * NET_MON_WIRE_SIZE]);
        count++;
    }
    p[0] = count;
    NetOutWrite(NET_MSG_PARTY_FULL, p, 1 + count * NET_MON_WIRE_SIZE);
}

// Cheap change detection so the full party is re-sent only when it changes.
// Called once per frame from NetTick.
void NetBattleTick(void)
{
    u16 sum = 0;
    u32 i;

    if (!NetIsOnline() || sPartyInjected)
        return;
    // Only report from the overworld: the party visible at the title screen
    // or during the intro belongs to a save that may be about to be re-init'd
    // (an empty pre-new-game party would wrongly summon the starter picker).
    if (gMain.callback2 != CB2_Overworld)
        return;
    if (sPartyResendDelay)
    {
        sPartyResendDelay--;
        return;
    }
    sPartyResendDelay = 64;

    for (i = 0; i < PARTY_SIZE; i++)
    {
        sum += GetMonData(&gPlayerParty[i], MON_DATA_SPECIES_OR_EGG, NULL);
        sum += GetMonData(&gPlayerParty[i], MON_DATA_LEVEL, NULL) << 8;
        sum += GetMonData(&gPlayerParty[i], MON_DATA_HP, NULL);
        sum += GetMonData(&gPlayerParty[i], MON_DATA_PERSONALITY, NULL) & 0xFF;
    }
    // First online tick always reports, even an empty party (checksum 0 would
    // otherwise match the zero-init and stay silent) — the web starter picker
    // keys off that empty summary.
    if (sum != sLastPartyChecksum || !sSentInitialParty)
    {
        sSentInitialParty = TRUE;
        sLastPartyChecksum = sum;
        NetSendPartySummary();
        NetSendFullParty();
    }
}

void NetSendPartySummary(void)
{
    u8 p[1 + 6 * 4];
    u8 count = 0;
    u32 i;

    if (!NetIsOnline())
        return;
    for (i = 0; i < PARTY_SIZE; i++)
    {
        u16 species = GetMonData(&gPlayerParty[i], MON_DATA_SPECIES_OR_EGG, NULL);
        u8 level;
        u8 hpPct;
        u16 hp, maxHp;

        if (species == SPECIES_NONE || species == SPECIES_EGG)
            continue;
        level = GetMonData(&gPlayerParty[i], MON_DATA_LEVEL, NULL);
        hp = GetMonData(&gPlayerParty[i], MON_DATA_HP, NULL);
        maxHp = GetMonData(&gPlayerParty[i], MON_DATA_MAX_HP, NULL);
        hpPct = maxHp ? (u8)((hp * 100) / maxHp) : 0;

        p[1 + count * 4 + 0] = species & 0xFF;
        p[1 + count * 4 + 1] = species >> 8;
        p[1 + count * 4 + 2] = level;
        p[1 + count * 4 + 3] = hpPct;
        count++;
    }
    p[0] = count;
    NetOutWrite(NET_MSG_PARTY_SUMMARY, p, 1 + count * 4);
}

void NetSendTurnInput(u8 action, u8 moveSlot, u8 target, u16 extra)
{
    u8 p[7];

    if (!sSession.active)
        return;
    p[0] = NET_BSUB_TURN_INPUT;
    p[1] = sSession.turnNo;
    p[2] = action;
    p[3] = moveSlot;
    p[4] = target;
    p[5] = extra & 0xFF;
    p[6] = extra >> 8;
    NetOutWrite(NET_MSG_BATTLE_EVENT, p, 7);
}

// Hooked at the top of CheckFocusPunch_ClearVarsBeforeTurnStarts — the first
// point that runs exactly once per turn with every battler's action/move
// finalized. Emit-only: reports the local player's side choices so peers and
// spectators can follow (and, in full lockstep, replay) the turn. Never
// mutates battle state.
void NetOnTurnFinalized(void)
{
    u32 i;

    if (!sSession.active || !NetIsOnline())
        return;

    sSession.turnNo++;
    for (i = 0; i < gBattlersCount; i++)
    {
        u8 p[7];

        if (GetBattlerSide(i) != B_SIDE_PLAYER)
            continue;
        p[0] = NET_BSUB_TURN_INPUT;
        p[1] = sSession.turnNo;
        p[2] = gChosenActionByBattler[i];
        p[3] = i; // battler index; move id travels in extra
        p[4] = 0;
        p[5] = gChosenMoveByBattler[i] & 0xFF;
        p[6] = gChosenMoveByBattler[i] >> 8;
        NetOutWrite(NET_MSG_BATTLE_EVENT, p, 7);
    }

    // Team mode: the previous turn's choices are locked, so the NEXT turn's
    // selection is about to begin — announce it (drives the spectator veil).
    NetTeamEmitTurnBegin();
}

// ---- team battles (T2.5 groundwork; docs/plans/TEAM-BATTLES.md §7) ----------

/** Whose choice drives this turn: rotate from the initiator through the team
 *  order — turn 0 = the member who hit the encounter. */
static u8 NetTeamControllerFor(u8 turn)
{
    u8 initIdx = 0;
    u8 i;

    if (sSession.playerCount == 0)
        return sSession.init;
    for (i = 0; i < sSession.playerCount && i < 4; i++)
        if (sSession.order[i] == sSession.init)
            initIdx = i;
    return sSession.order[(initIdx + turn) % sSession.playerCount];
}

/** Report the current turn's selection start (BATTLE_EVENT sub 4). The server
 *  dedupes per (sid, turn) across participants and fans out battle.turn, which
 *  drives the web spectator veil ("P2 is choosing…"). */
void NetTeamEmitTurnBegin(void)
{
    u8 p[3];

    if (!sSession.active || sSession.mode != NET_BMODE_TEAM || !NetIsOnline())
        return;
    p[0] = NET_BSUB_TURN_BEGIN;
    p[1] = sSession.turnNo;
    p[2] = NetTeamControllerFor(sSession.turnNo);
    NetOutWrite(NET_MSG_BATTLE_EVENT, p, 3);
}

// Called once per frame from NetTick: a team member who did not open the
// encounter enters the identical battle — same enemy (shipped wire mon), same
// merged party (injected at START), same seed. Entry uses the scripted-wild
// path the WILD_BATTLE admin command already uses, then overwrites the rolled
// enemy with the exact wire bytes before the engine reads it.
//
// VERIFY-ON-HOST: peer entry + mid-intro party injection need a real
// two-instance ROM test (plan §11) before T2.5 is called done.
void NetTeamTick(void)
{
    u16 species;

    if (!sPendingPeerEntry)
        return;
    if (gMain.callback2 != CB2_Overworld || ArePlayerFieldControlsLocked())
        return; // same context a field script requires; retry next frame
    sPendingPeerEntry = FALSE;

    species = (u16)(sEnemyWire[8] | (sEnemyWire[9] << 8));
    if (species == SPECIES_NONE)
        return;
    CreateScriptedWildMon(species, sEnemyWire[20], 0);
    MonFromWire(sEnemyWire, &gEnemyParty[0]); // exact mon, not a fresh roll
    NetLog("team: entering shared battle");
    BattleSetup_StartScriptedWildBattle();
}

void NetSendBattleOutcome(u8 result)
{
    u8 p[2];

    if (!sSession.active)
        return;
    p[0] = NET_BSUB_END_OR_OUTCOME;
    p[1] = result;
    NetOutWrite(NET_MSG_BATTLE_EVENT, p, 2);
    sSession.active = FALSE;
}

void NetOnBattleCmd(const u8 *payload, u8 len)
{
    if (len < 1)
        return;

    switch (payload[0])
    {
    case NET_BSUB_START_OR_ENCOUNTER: // START {seed u32, count u8, order[4], mode u8[, init u8, enemyCount u8, wire…]}
        if (len < 11)
            return;
        sSession.active = TRUE;
        sSession.seed = RD_U32(payload, 1);
        sSession.playerCount = payload[5];
        sSession.order[0] = payload[6];
        sSession.order[1] = payload[7];
        sSession.order[2] = payload[8];
        sSession.order[3] = payload[9];
        sSession.mode = payload[10];
        sSession.turnNo = 0;
        sSession.init = sSession.order[0];
        // Team extension: the encounter opener's slot + the exact enemy.
        if (sSession.mode == NET_BMODE_TEAM && len >= 13)
        {
            sSession.init = payload[11];
            if (payload[12] >= 1 && len >= 13 + NET_MON_WIRE_SIZE)
            {
                memcpy(sEnemyWire, &payload[13], NET_MON_WIRE_SIZE);
                sHaveEnemy = TRUE;
            }
            // A member who did NOT open the encounter must be pulled into the
            // identical battle; queued for the next quiet overworld frame.
            if (!sIsInitiator && sHaveEnemy)
                sPendingPeerEntry = TRUE;
            NetTeamEmitTurnBegin(); // turn 0: the initiator is choosing
        }
        // Co-op/team: the merged party staged by NET_BSUB_PARTY takes the field.
        if (sSession.mode != NET_BMODE_PVP)
            InjectPendingParty();
        // Deterministic lockstep starts here: every participant seeds the
        // same RNG before the battle engine draws from it.
        SeedRng((u16)sSession.seed);
        SeedRng2((u16)(sSession.seed >> 16));
        break;

    case NET_BSUB_TURN_INPUT: // relayed {turn u8, fromSlot u8, action u8, move u8, tgt u8, extra u16}
        if (len < 8 || !sSession.active)
            return;
        // T3 (docs/plans/TEAM-BATTLES.md §7.2): feed into the battle
        // controller for the acting battler. Until then the relay only keeps
        // the turn counter in step.
        sSession.turnNo = payload[1];
        break;

    case NET_BSUB_END_OR_OUTCOME:
        sSession.active = FALSE;
        sIsInitiator = FALSE;
        sHaveEnemy = FALSE;
        sPendingPeerEntry = FALSE;
        RestorePartyIfInjected();
        break;

    case NET_BSUB_PARTY: // {count u8, count * NET_MON_WIRE_SIZE bytes}
        if (len < 2 || payload[1] > PARTY_SIZE ||
            len < 2 + payload[1] * NET_MON_WIRE_SIZE)
            return;
        memcpy(sPendingParty, &payload[1], 1 + payload[1] * NET_MON_WIRE_SIZE);
        sHavePendingParty = TRUE;
        break;
    }
}
