// Wire-protocol helpers. Schema: docs/PROTOCOL.md §2.

/** Message types accepted from bridges, with required numeric fields. */
const CLIENT_MESSAGES = {
  hello: [],
  pos: ['g', 'n', 'x', 'y', 'f', 's'],
  flag: ['id'],
  var: ['id', 'v'],
  party: [],
  'party.full': [],
  'battle.open': ['kind', 'opp'],
  'battle.join': [],
  'battle.input': ['turn', 'a'],
  'battle.end': ['result'],
  tp: ['to'],
  pvp: ['to'],
  'pvp.accept': ['from'],
  ping: [],
};

/**
 * Parse and shallow-validate one wire message.
 * @param {string|Buffer} raw
 * @returns {{ok: true, msg: any} | {ok: false, error: string}}
 */
export function parseMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'bad json' };
  }
  if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') {
    return { ok: false, error: 'missing type' };
  }
  const fields = CLIENT_MESSAGES[msg.t];
  if (!fields) return { ok: false, error: `unknown type ${msg.t}` };
  for (const f of fields) {
    if (!Number.isFinite(msg[f])) return { ok: false, error: `${msg.t}: bad field ${f}` };
  }
  return { ok: true, msg };
}

export function inRanges(id, ranges) {
  return ranges.some(([lo, hi]) => id >= lo && id <= hi);
}
