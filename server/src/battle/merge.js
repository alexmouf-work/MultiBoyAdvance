// Co-op party merge rule. docs/PROTOCOL.md §2.3:
// from each participant take its top ceil(6/N) mons by level (tie-break:
// earlier party position), then trim to 6 by highest level overall.

const PARTY_SIZE = 6;

/**
 * @param {Array<{slot: number, mons: Array<{sp: number, lv: number, hp?: number}>}>} participants
 *   in turn order; `mons` is each player's own party summary in party order.
 * @returns {Array<{owner: number, idx: number, sp: number, lv: number}>}
 *   merged party, each entry tagged with owner slot + index in the owner's party.
 */
export function mergeParties(participants) {
  const n = participants.length;
  if (n === 0) return [];
  const perPlayer = Math.ceil(PARTY_SIZE / n);

  const picked = [];
  for (const p of participants) {
    const ranked = (p.mons ?? [])
      .map((m, idx) => ({ owner: p.slot, idx, sp: m.sp, lv: m.lv }))
      .sort((a, b) => b.lv - a.lv || a.idx - b.idx)
      .slice(0, perPlayer);
    picked.push(...ranked);
  }

  return picked
    .sort((a, b) => b.lv - a.lv || a.owner - b.owner || a.idx - b.idx)
    .slice(0, PARTY_SIZE);
}
