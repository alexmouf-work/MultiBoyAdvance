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

/**
 * Team lineup default: each member's top-N party indices by level (tie-break:
 * earlier party position), in that rank order.
 * @param {Array<{lv: number}>} fullMons
 * @returns {number[]} ordered party indices
 */
export function defaultTopPicks(fullMons, n = 3) {
  return (fullMons ?? [])
    .map((m, idx) => ({ idx, lv: m.lv }))
    .sort((a, b) => b.lv - a.lv || a.idx - b.idx)
    .slice(0, n)
    .map((x) => x.idx);
}

/**
 * Team-battle lineup merge (docs/plans/TEAM-BATTLES.md §4.2): each member
 * contributes an ORDERED list of up to 3 party indices (their team-builder
 * picks, defaulting to top-3 by level), and the send-out order interleaves by
 * rank across members in team order (leader first): A1,B1,(C1),A2,B2,(C2),…
 * capped at the 6-mon party.
 * @param {Array<{slot: number, fullMons: Array<{lv: number, b: number[]}>, picks?: number[]|null}>} members
 *   in TEAM order (leader first).
 * @returns {number[][]} merged 32-byte blobs in send-out order
 */
export function mergeLineupWire(members) {
  const perMember = 3;
  const chosen = members.map((m) => {
    const picks = (m.picks?.length ? m.picks : defaultTopPicks(m.fullMons, perMember))
      .filter((i) => Number.isInteger(i) && m.fullMons?.[i])
      .slice(0, perMember);
    return picks.map((i) => m.fullMons[i].b);
  });
  const merged = [];
  for (let rank = 0; rank < perMember; rank++) {
    for (const c of chosen) if (c[rank]) merged.push(c[rank]);
  }
  return merged.slice(0, PARTY_SIZE);
}

/**
 * Same rule over full wire mons (docs/PROTOCOL.md §1.5): each participant's
 * `fullMons` is [{lv, b: number[32]}]. Returns the merged 32-byte blobs in
 * final party order, for battle.start's `partyWire`.
 * @param {Array<{slot: number, fullMons: Array<{lv: number, b: number[]}>}>} participants
 * @returns {number[][]}
 */
export function mergeWireParties(participants) {
  const n = participants.length;
  if (n === 0) return [];
  const perPlayer = Math.ceil(PARTY_SIZE / n);

  const picked = [];
  for (const p of participants) {
    const ranked = (p.fullMons ?? [])
      .map((m, idx) => ({ owner: p.slot, idx, lv: m.lv, b: m.b }))
      .sort((a, b) => b.lv - a.lv || a.idx - b.idx)
      .slice(0, perPlayer);
    picked.push(...ranked);
  }

  return picked
    .sort((a, b) => b.lv - a.lv || a.owner - b.owner || a.idx - b.idx)
    .slice(0, PARTY_SIZE)
    .map((m) => m.b);
}
