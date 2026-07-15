// Console command parsing/execution. Lines arrive as {t:'cmd', line} from any
// player (friends-trust model); most commands resolve to an 'admin' message
// delivered to the target's bridge, which writes it into that game's mailbox.

const HELP = [
  '/players — list who is online',
  '/give <player> item <itemId> [qty] — put items in their bag',
  '/give <player> mon <speciesId> [level] — add a Pokémon to their party',
  '/setlevel <player> <slot 1-6> <level> — set a party Pokémon\'s level',
  '/xp <player> <slot 1-6> <amount> — grant experience',
  '/battle <player> wild <speciesId> [level] — start a wild battle on their screen',
  '/resettrainer <player> <trainerId> — un-defeat an NPC trainer (rewards keep)',
  '/tp <player> — request to teleport to them (they accept)',
  '/warp <group> <map> <x> <y> — warp yourself to map coordinates',
].join('\n');

function findTarget(world, me, word) {
  if (!word) return null;
  const w = word.toLowerCase();
  if (w === 'me' || w === 'self') return me;
  const bySlot = /^p?(\d+)$/.exec(w);
  if (bySlot) {
    const c = world.clients.get(Number(bySlot[1]) - 1);
    if (c) return c;
  }
  for (const c of world.clients.values()) if (c.name.toLowerCase() === w) return c;
  return null;
}

const int = (s, lo, hi) => {
  const n = Number(s);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/**
 * @returns {{ok: boolean, msg: string}}
 */
export function runCommand(world, me, line) {
  const [cmd, ...a] = String(line).trim().split(/\s+/);
  const send = (c, admin) => c.send({ t: 'admin', ...admin });

  switch ((cmd ?? '').toLowerCase()) {
    case '/help':
      return { ok: true, msg: HELP };

    case '/players':
      return {
        ok: true,
        msg: [...world.clients.values()]
          .map((c) => `P${c.slot + 1} ${c.name}${c.map ? ` @ map ${c.map.g}.${c.map.n}` : ''}`)
          .join('\n') || 'nobody online',
      };

    case '/give': {
      const target = findTarget(world, me, a[0]);
      if (!target) return { ok: false, msg: `unknown player "${a[0] ?? ''}" — /players` };
      if (a[1] === 'item') {
        const item = int(a[2], 1, 0xffff);
        const qty = a[3] === undefined ? 1 : int(a[3], 1, 999);
        if (item === null || qty === null) return { ok: false, msg: 'usage: /give <player> item <itemId> [qty]' };
        send(target, { sub: 'give_item', item, qty });
        return { ok: true, msg: `gave ${target.name} item ${item} ×${qty}` };
      }
      if (a[1] === 'mon') {
        const species = int(a[2], 1, 0xffff);
        const level = a[3] === undefined ? 5 : int(a[3], 1, 100);
        if (species === null || level === null) return { ok: false, msg: 'usage: /give <player> mon <speciesId> [level]' };
        send(target, { sub: 'give_mon', species, level });
        return { ok: true, msg: `gave ${target.name} species ${species} lv${level}` };
      }
      return { ok: false, msg: 'usage: /give <player> item|mon …' };
    }

    case '/setlevel': {
      const target = findTarget(world, me, a[0]);
      const slot = int(a[1], 1, 6);
      const level = int(a[2], 1, 100);
      if (!target || slot === null || level === null) return { ok: false, msg: 'usage: /setlevel <player> <slot 1-6> <level>' };
      send(target, { sub: 'set_level', slot: slot - 1, level });
      return { ok: true, msg: `${target.name}'s slot ${slot} set to lv${level}` };
    }

    case '/xp': {
      const target = findTarget(world, me, a[0]);
      const slot = int(a[1], 1, 6);
      const xp = int(a[2], 1, 1_000_000);
      if (!target || slot === null || xp === null) return { ok: false, msg: 'usage: /xp <player> <slot 1-6> <amount>' };
      send(target, { sub: 'give_xp', slot: slot - 1, xp });
      return { ok: true, msg: `granted ${xp} xp to ${target.name}'s slot ${slot}` };
    }

    case '/battle': {
      const target = findTarget(world, me, a[0]);
      if (!target || a[1] !== 'wild') return { ok: false, msg: 'usage: /battle <player> wild <speciesId> [level]' };
      const species = int(a[2], 1, 0xffff);
      const level = a[3] === undefined ? 5 : int(a[3], 1, 100);
      if (species === null || level === null) return { ok: false, msg: 'usage: /battle <player> wild <speciesId> [level]' };
      send(target, { sub: 'wild_battle', species, level });
      return { ok: true, msg: `wild battle (species ${species} lv${level}) started on ${target.name}'s screen` };
    }

    case '/resettrainer': {
      const target = findTarget(world, me, a[0]);
      const trainer = int(a[1], 0, 0x35f);
      if (!target || trainer === null) return { ok: false, msg: 'usage: /resettrainer <player> <trainerId>' };
      send(target, { sub: 'reset_trainer', trainer });
      return { ok: true, msg: `trainer ${trainer} reset for ${target.name}` };
    }

    case '/tp': {
      const target = findTarget(world, me, a[0]);
      if (!target || target === me) return { ok: false, msg: 'usage: /tp <player>' };
      world.requestTeleport(me, target);
      return { ok: true, msg: `teleport request sent to ${target.name}` };
    }

    case '/warp': {
      const g = int(a[0], 0, 255);
      const n = int(a[1], 0, 255);
      const x = int(a[2], 0, 4095);
      const y = int(a[3], 0, 4095);
      if (g === null || n === null || x === null || y === null) return { ok: false, msg: 'usage: /warp <group> <map> <x> <y>' };
      me.send({ t: 'warp', g, n, x, y });
      return { ok: true, msg: `warping you to map ${g}.${n} (${x},${y})` };
    }

    default:
      return { ok: false, msg: `unknown command — /help` };
  }
}
