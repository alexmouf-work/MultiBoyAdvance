// DOM overlays: roster, status chips, event log, battle offers, teleport/PvP.
// Deliberately framework-free; elements carry stable ids/data attributes so
// the e2e suite can assert on them.

import { mapName } from '../data/map-names.js';

const PLAYER_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f5a623', '#8e4ec6', '#00b3c2', '#d6409f', '#846358'];

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function offlineLine(u) {
  const where = mapName(u.g, u.n);
  const ago = u.lastSeenAt ? `seen ${formatDuration(Date.now() - u.lastSeenAt)} ago` : '';
  return [where, ago].filter(Boolean).join(' · ') || 'offline';
}

export class UI {
  constructor(socket, bridge, adapter) {
    this.socket = socket;
    this.bridge = bridge;
    this.adapter = adapter;
    this.slot = null;
    this.players = new Map(); // slot -> {name, joinedAt (local clock)}
    this.directory = []; // every trainer the server knows (incl. offline)
    this.ghosts = new Map(); // slot -> last ghost pos (proximity checks)
    this.$ = (sel) => document.querySelector(sel);
    this.#wire();
    this.#wireConsole();
    this.#wireStarter();
    this.#wireProximity();
    this.bridge.onParty = (mons) => this.#onOwnParty(mons);
    setInterval(() => this.#tickDurations(), 1000);
    setInterval(() => this.#tickProximity(), 500);
  }

  #tickDurations() {
    for (const li of this.$('#players')?.querySelectorAll('li') ?? []) {
      if (li.classList.contains('offline')) continue; // "seen … ago" refreshes on re-render
      const p = this.players.get(Number(li.dataset.slot));
      if (p) li.querySelector('.dur').textContent = `online ${formatDuration(Date.now() - p.joinedAt)}`;
    }
  }

  log(kind, text) {
    const li = document.createElement('li');
    li.dataset.t = kind;
    li.textContent = text;
    this.$('#log').prepend(li);
    while (this.$('#log').children.length > 60) this.$('#log').lastChild.remove();
  }

  setStatus(chip, text, ok = null) {
    const el = this.$(chip);
    el.textContent = text;
    el.className = `chip ${ok === null ? '' : ok ? 'ok' : 'warn'}`;
  }

  #renderPlayers() {
    const tab = this.$('#sidebar-tab');
    if (tab) tab.textContent = `👥\n${this.players.size}`;
    const ul = this.$('#players');
    ul.innerHTML = '';
    for (const [slot, p] of [...this.players.entries()].sort((a, b) => a[0] - b[0])) {
      const li = document.createElement('li');
      li.dataset.slot = slot;

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = PLAYER_COLORS[slot % PLAYER_COLORS.length];
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = `${p.name}${slot === this.slot ? ' (you)' : ''}`;
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = `online ${formatDuration(Date.now() - p.joinedAt)}`;
      li.append(dot, name, dur);

      if (slot !== this.slot) {
        const actions = document.createElement('span');
        actions.className = 'actions';
        const tp = document.createElement('button');
        tp.textContent = 'teleport';
        tp.dataset.action = 'tp';
        tp.onclick = () => this.socket.send({ t: 'tp', to: slot });
        const pvp = document.createElement('button');
        pvp.textContent = 'battle';
        pvp.dataset.action = 'pvp';
        pvp.onclick = () => this.socket.send({ t: 'pvp', to: slot });
        actions.append(tp, pvp);
        li.append(actions);
      }
      ul.append(li);
    }

    // Offline trainers, dimmed, with where they logged out (server registry).
    const onlineNames = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    for (const u of this.directory) {
      if (u.online || onlineNames.has(u.name.toLowerCase())) continue;
      const li = document.createElement('li');
      li.className = 'offline';
      const dot = document.createElement('span');
      dot.className = 'dot off';
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = u.name;
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = offlineLine(u);
      li.append(dot, name, dur);
      ul.append(li);
    }
  }

  #wire() {
    const s = this.socket;
    s.on('_open', () => this.setStatus('#chip-server', 'server: connected', true));
    s.on('_close', () => this.setStatus('#chip-server', 'server: reconnecting…', false));
    s.on('welcome', (m) => {
      this.slot = m.slot;
      this.players.clear();
      this.players.set(m.slot, {
        name: this.$('#name').value || `Player${m.slot + 1}`,
        joinedAt: Date.now(),
      });
      // onlineMs from the server -> local join instant, so durations tick on
      // the local clock with no cross-machine skew.
      for (const p of m.players) {
        this.players.set(p.slot, { name: p.name, joinedAt: Date.now() - (p.onlineMs ?? 0) });
      }
      this.directory = m.users ?? [];
      this.#renderPlayers();
      this.log('welcome', `joined as P${m.slot + 1} · ${m.flags.length} world flags known`);
      if (m.speed > 1) this.#applySpeed(m.speed);
    });
    s.on('users', (m) => {
      this.directory = m.users ?? [];
      this.#renderPlayers();
    });
    s.on('speed', (m) => {
      this.#applySpeed(m.x);
      this.log('speed', `game speed set to ${m.x}× (for everyone)`);
    });
    s.on('join', (m) => {
      if (m.sid) return; // battle-join notices handled in log only
      this.players.set(m.slot, { name: m.name, joinedAt: Date.now() });
      this.#renderPlayers();
      this.log('join', `${m.name} joined`);
    });
    s.on('leave', (m) => {
      this.players.delete(m.slot);
      this.ghosts.delete(m.slot);
      this.#renderPlayers();
      this.log('leave', `P${m.slot + 1} left`);
    });
    s.on('ghost', (m) => {
      if (m.s === 255) this.ghosts.delete(m.slot);
      else {
        this.ghosts.set(m.slot, m);
        this.log('ghost', `P${m.slot + 1} @ map ${m.g}.${m.n} (${m.x},${m.y})`);
      }
    });
    s.on('flag', (m) => this.log('flag', `world flag 0x${m.id.toString(16)} set`));
    s.on('battle.offer', (m) => this.#showOffer(m));
    s.on('battle.start', (m) => {
      this.log('battle.start', `battle ${m.sid} started · seed ${m.seed >>> 0} · order [${m.order.join(',')}] · ${m.mode}`);
      this.$('#btn-end-battle').hidden = m.order?.[0] !== this.slot;
    });
    s.on('battle.end', (m) => {
      this.log('battle.end', `battle ${m.sid} ended · result ${m.result}`);
      this.$('#btn-end-battle').hidden = true;
    });
    s.on('warp', (m) => this.log('warp', `warped to map ${m.g}.${m.n} (${m.x},${m.y})`));
    s.on('pvp.req', (m) => this.#showPvpChallenge(m));
    s.on('tp.req', (m) => this.#showTpRequest(m));
    s.on('trade.recv', (m) => {
      this.#toast(`🎁 ${m.name} sent you item #${m.item} ×${m.qty}`, { ttl: 8000 });
      this.log('trade', `${m.name} sent item ${m.item} ×${m.qty}`);
    });
    s.on('admin', (m) => this.log('admin', this.#adminText(m)));
    s.on('error', (m) => this.log('error', m.msg));
  }

  #adminText(m) {
    switch (m.sub) {
      case 'give_item': return `received item ${m.item} ×${m.qty}`;
      case 'take_item': return `item ${m.item} ×${m.qty} taken from bag`;
      case 'give_mon': return `received Pokémon #${m.species} lv${m.level}`;
      case 'set_level': return `party slot ${m.slot + 1} set to lv${m.level}`;
      case 'give_xp': return `party slot ${m.slot + 1} gained ${m.xp} xp`;
      case 'wild_battle': return `a wild Pokémon #${m.species} lv${m.level} appears!`;
      case 'reset_trainer': return `trainer ${m.trainer} reset`;
      default: return `admin: ${m.sub}`;
    }
  }

  #applySpeed(x) {
    this.adapter.setSpeed?.(x);
    const btn = document.querySelector('#btn-speed');
    if (btn) btn.textContent = `⚡ ${x}×`;
    for (const b of document.querySelectorAll('#speed-menu button')) {
      b.classList.toggle('on', Number(b.dataset.x) === x);
    }
  }

  // ---- top-of-screen toasts (inside #gamewrap, so they show in fullscreen) ----

  /**
   * @param {string} text
   * @param {{ttl?: number, action?: string, label?: string, onAction?: () => void, sid?: string}} opts
   */
  #toast(text, opts = {}) {
    const box = this.$('#offers');
    const div = document.createElement('div');
    div.className = 'offer';
    if (opts.sid) div.dataset.sid = opts.sid;
    const span = document.createElement('span');
    span.textContent = text;
    div.append(span);
    if (opts.onAction) {
      const btn = document.createElement('button');
      btn.textContent = opts.label ?? 'OK';
      if (opts.action) btn.dataset.action = opts.action;
      btn.onclick = () => {
        opts.onAction();
        div.remove();
      };
      div.append(btn);
    }
    box.append(div);
    setTimeout(() => div.remove(), opts.ttl ?? 10_000);
    return div;
  }

  #showOffer(m) {
    this.#toast(`⚔️ P${m.from + 1} is battling (opp ${m.opp})`, {
      sid: m.sid,
      ttl: m.ttl ?? 10_000,
      action: 'join-battle',
      label: 'Join battle',
      onAction: () => {
        this.bridge.joinBattle(m.sid);
        this.log('battle.join', `joined ${m.sid}`);
      },
    });
  }

  #showPvpChallenge(m) {
    this.#toast(`⚔️ ${m.name} challenges you to a battle!`, {
      ttl: 15_000,
      action: 'pvp-accept',
      label: 'Accept',
      onAction: () => this.socket.send({ t: 'pvp.accept', from: m.from }),
    });
  }

  #showTpRequest(m) {
    this.#toast(`📍 ${m.name} wants to teleport to you`, {
      ttl: 60_000, // matches the server-side request TTL
      action: 'tp-accept',
      label: 'Accept',
      onAction: () => this.socket.send({ t: 'tp.accept', from: m.from }),
    });
  }

  // ---- console ----

  #wireConsole() {
    const input = this.$('#console-in');
    this.$('#console-form').onsubmit = (e) => {
      e.preventDefault();
      const line = input.value.trim();
      if (!line) return;
      this.#consolePrint(`> ${line}`, null);
      this.socket.send({ t: 'cmd', line });
      input.value = '';
    };
    this.socket.on('cmd.result', (m) => this.#consolePrint(m.msg, m.ok));
  }

  #consolePrint(text, ok) {
    const out = this.$('#console-out');
    const li = document.createElement('li');
    if (ok !== null) li.dataset.ok = String(ok);
    li.textContent = text;
    out.append(li);
    while (out.children.length > 80) out.firstChild.remove();
    li.scrollIntoView({ block: 'nearest' });
  }

  // ---- starter picker (new save: party is empty until a starter is chosen) ----

  #wireStarter() {
    for (const b of this.$('#starter-modal').querySelectorAll('button')) {
      b.onclick = () => {
        this.socket.send({ t: 'starter', species: Number(b.dataset.species) });
        this.$('#starter-modal').hidden = true;
        this.log('starter', 'starter chosen — welcome to Hoenn!');
      };
    }
  }

  #onOwnParty(mons) {
    // The ROM reports the party once online (even when empty); an empty party
    // means a fresh save that still needs its starter.
    this.$('#starter-modal').hidden = mons.length !== 0;
  }

  // ---- ghost proximity: stand next to another player to interact ----

  #wireProximity() {
    const form = this.$('#prox-give-form');
    this.$('#btn-prox-battle').onclick = () => {
      if (this.proxSlot === undefined) return;
      this.socket.send({ t: 'pvp', to: this.proxSlot });
      this.log('pvp', `challenge sent to P${this.proxSlot + 1}`);
    };
    this.$('#btn-prox-give').onclick = () => {
      form.hidden = !form.hidden;
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const item = Number(this.$('#prox-item').value);
      const qty = Number(this.$('#prox-qty').value) || 1;
      if (!item || this.proxSlot === undefined) return;
      this.socket.send({ t: 'trade.give', to: this.proxSlot, item, qty });
      this.log('trade', `sent item ${item} ×${qty} to P${this.proxSlot + 1}`);
      form.hidden = true;
    };
  }

  #tickProximity() {
    const chip = this.$('#proximity');
    const my = this.bridge.myPos;
    let found;
    if (my) {
      for (const [slot, g] of this.ghosts) {
        if (slot === this.slot) continue;
        if (g.g === my.g && g.n === my.n && Math.abs(g.x - my.x) + Math.abs(g.y - my.y) <= 1) {
          found = slot;
          break;
        }
      }
    }
    if (found === this.proxSlot) return;
    this.proxSlot = found;
    if (found === undefined) {
      chip.hidden = true;
      this.$('#prox-give-form').hidden = true;
    } else {
      this.$('#proximity-name').textContent = this.players.get(found)?.name ?? `P${found + 1}`;
      chip.hidden = false;
    }
  }
}
