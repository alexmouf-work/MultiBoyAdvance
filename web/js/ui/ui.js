// DOM overlays: roster, status chips, event log, battle offers, teleport/PvP.
// Deliberately framework-free; elements carry stable ids/data attributes so
// the e2e suite can assert on them.

import { mapName } from '../data/map-names.js';
import { wipeLocalData } from '../recovery.js';

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
    this.myParty = []; // own party summary [{sp,lv,hp}] (trade picker source)
    this.trade = null; // open trade modal state (docs/plans/TRADING.md §8.2)
    this.team = null; // latest team.update (docs/plans/TEAM-BATTLES.md T1)
    this.teamPicks = null; // working copy of my line-up picks in the builder
    this.teamBattle = null; // {sid} while a team battle session is live (veil)
    this.$ = (sel) => document.querySelector(sel);
    this.#wire();
    this.#wireConsole();
    this.#wireStarter();
    this.#wireProximity();
    this.#wireTrade();
    this.#wireTeam();
    this.#wireFriends();
    this.bridge.onParty = (mons) => this.#onOwnParty(mons);
    this.bridge.onLog = (text) => this.#debugLog(text);
    const resetBtn = this.$('#btn-reset-storage');
    if (resetBtn) resetBtn.onclick = () => this.resetEmulatorStorage();
    setInterval(() => this.#tickDurations(), 1000);
    setInterval(() => this.#tickProximity(), 500);
    setInterval(() => this.#tickDebug(), 500);
  }

  // ---- debug panel: the game's live heartbeat + its log feed ----

  #debugLog(text) {
    const out = this.$('#debug-log');
    if (!out) return;
    const li = document.createElement('li');
    li.textContent = text;
    if (/STALLED/.test(text)) li.dataset.warn = '1';
    out.prepend(li);
    while (out.children.length > 80) out.lastChild.remove();
  }

  #tickDebug() {
    const el = this.$('#debug-stat');
    if (!el) return;
    const states = ['boot', 'overworld', 'battle', 'menu', 'other'];
    const lf = this.bridge.lastFrame;
    el.textContent = lf
      ? `frame ${lf.fc} · ${states[lf.gs] ?? `state ${lf.gs}`} · mailbox: ${this.bridge.status}`
      : `mailbox: ${this.bridge.status}`;
    el.classList.toggle('warn', this.bridge.status === 'stalled');
  }

  // Last-resort recovery: a crashed session can corrupt the emulator's
  // IndexedDB filesystem, which then garbles every later boot on this browser.
  // Server-side saves make this safe to wipe. The implementation lives in
  // js/recovery.js so the pre-login start-screen console can offer the same
  // recovery without booting the game first.
  wipeLocalData(opts) {
    return wipeLocalData(opts);
  }

  resetEmulatorStorage() {
    if (!confirm('Clear this browser\'s cached emulator files and reload? Your progress is safe on the server.')) return;
    this.wipeLocalData();
  }

  #tickDurations() {
    for (const sel of ['#players', '#friends-list']) {
      for (const li of this.$(sel)?.querySelectorAll('li') ?? []) {
        if (li.classList.contains('offline') || !li.dataset.slot) continue; // "seen … ago" refreshes on re-render
        const p = this.players.get(Number(li.dataset.slot));
        if (p) li.querySelector('.dur').textContent = `online ${formatDuration(Date.now() - p.joinedAt)}`;
      }
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
    this.#buildRoster(this.$('#players'), false);
    const fl = this.$('#friends-list');
    if (fl) {
      const shown = this.#buildRoster(fl, true); // friends panel: skip yourself
      const empty = this.$('#friends-empty');
      if (empty) empty.hidden = shown > 0;
    }
  }

  /** Build the trainer roster into `ul` (online with action buttons, then
   *  offline trainers). Shared by the sidebar and the left friends panel.
   *  @param {boolean} skipSelf omit your own row (the friends panel does)
   *  @returns {number} rows rendered */
  #buildRoster(ul, skipSelf) {
    if (!ul) return 0;
    ul.innerHTML = '';
    let shown = 0;
    const closePanels = () => this.$('#friends-panel')?.classList.remove('open');

    for (const [slot, p] of [...this.players.entries()].sort((a, b) => a[0] - b[0])) {
      if (skipSelf && slot === this.slot) continue;
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
        const act = (label, action, fn) => {
          const b = document.createElement('button');
          b.textContent = label;
          b.dataset.action = action;
          b.onclick = () => { fn(); closePanels(); };
          return b;
        };
        actions.append(
          act('teleport', 'tp', () => this.socket.send({ t: 'tp', to: slot })),
          act('battle', 'pvp', () => this.socket.send({ t: 'pvp', to: slot })),
          act('trade', 'trade', () => this.#openTradeEditor(slot)),
          act('team', 'team-invite', () => {
            // First invite also creates the team (create is idempotent).
            this.socket.send({ t: 'team.create' });
            this.socket.send({ t: 'team.invite', to: slot });
            this.log('team', `team invite sent to ${p.name}`);
          }),
        );
        li.append(actions);
      }
      ul.append(li);
      shown++;
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
      shown++;
    }
    return shown;
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
      const reporter = m.mode === 'team' ? m.init : m.order?.[0];
      this.$('#btn-end-battle').hidden = reporter !== this.slot;
      if (m.mode === 'team') {
        // Arm the spectator veil: turn 0 belongs to the encounter's initiator.
        this.teamBattle = { sid: m.sid };
        this.#setVeil(m.init !== this.slot, m.init);
      }
    });
    s.on('battle.turn', (m) => {
      if (this.teamBattle?.sid !== m.sid) return;
      this.#setVeil(m.controller !== this.slot, m.controller);
      this.log('battle.turn', `turn ${m.turn}: P${m.controller + 1} is choosing`);
    });
    s.on('battle.end', (m) => {
      this.log('battle.end', `battle ${m.sid} ended · result ${m.result}`);
      this.$('#btn-end-battle').hidden = true;
      if (this.teamBattle?.sid === m.sid) {
        this.teamBattle = null;
        this.#setVeil(false);
      }
    });
    s.on('warp', (m) => this.log('warp', `warped to map ${m.g}.${m.n} (${m.x},${m.y})`));
    s.on('pvp.req', (m) => this.#showPvpChallenge(m));
    s.on('tp.req', (m) => this.#showTpRequest(m));
    s.on('trade.recv', (m) => {
      this.#toast(`🎁 ${m.name} sent you item #${m.item} ×${m.qty}`, { ttl: 8000 });
      this.log('trade', `${m.name} sent item ${m.item} ×${m.qty}`);
    });
    s.on('trade.req', (m) => {
      this.log('trade', `${m.name} offered a trade`);
      this.#toast(`🔁 ${m.name} has offered a trade`, {
        ttl: 115_000, // just under the server's 2-min offer TTL
        action: 'trade-open',
        label: 'Open',
        onAction: () => this.#openTradeReview(m),
      });
    });
    s.on('trade.cancelled', (m) => {
      this.#toast('❌ trade cancelled', { ttl: 6000 });
      this.log('trade', `trade with P${m.from + 1} cancelled (${m.reason ?? '?'})`);
    });
    s.on('trade.done', (m) => {
      this.#toast(m.ok ? `✅ trade complete — ${m.summary ?? ''}` : `⚠️ trade failed — ${m.msg ?? ''}`, { ttl: 8000 });
      this.log('trade', m.ok ? `trade complete: ${m.summary ?? ''}` : `trade failed: ${m.msg ?? ''}`);
    });
    s.on('team.req', (m) => {
      this.log('team', `${m.name} invited you to their team`);
      this.#toast(`👥 ${m.name} invited you to a team`, {
        ttl: 115_000, // just under the server's invite TTL
        action: 'team-accept',
        label: 'Accept',
        onAction: () => this.socket.send({ t: 'team.accept', from: m.from }),
      });
    });
    s.on('team.update', (m) => {
      this.team = m;
      this.#renderTeamPanel();
      if (!this.$('#team-modal').hidden) this.#renderTeamBuilder();
    });
    s.on('team.left', (m) => {
      if (m.declined) {
        this.log('team', `P${m.slot + 1} declined the team invite`);
        return;
      }
      if (m.disbanded || m.slot === this.slot) {
        this.team = null;
        this.teamPicks = null;
        this.$('#team-modal').hidden = true;
        this.#toast(m.disbanded ? '👥 the team was disbanded' : '👥 you left the team', { ttl: 6000 });
      }
      this.log('team', m.disbanded ? 'team disbanded' : `P${m.slot + 1} left the team`);
      this.#renderTeamPanel();
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
      case 'take_mon': return `party slot ${m.slot + 1} (Pokémon #${m.sp}) traded away`;
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
      input.value = '';
      // Browser-local commands never reach the server.
      if (line.toLowerCase() === '/resetlocal') {
        this.#consolePrint('wiping this browser\'s local data (settings + cached emulator files), reloading…', true);
        this.wipeLocalData({ includePrefs: true });
        return;
      }
      this.socket.send({ t: 'cmd', line });
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
    this.myParty = mons;
    this.$('#starter-modal').hidden = mons.length !== 0;
    // A live trade editor should track party changes (e.g. mid-edit level-up).
    if (this.trade?.mode === 'edit') this.#renderTradeEdit();
  }

  // ---- trading GUI (docs/plans/TRADING.md §8) --------------------------------
  // One modal, two modes. Review: an incoming offer with Accept / Counter /
  // Reject. Edit: compose an offer — pick own party mons by tapping chips,
  // add items by id, request species/items from the other side (blind).

  #termLabel(x) {
    return x.sp !== undefined ? `Pokémon #${x.sp}` : `item #${x.id} ×${x.qty}`;
  }

  #tradePeerName(slot) {
    return this.players.get(slot)?.name ?? `P${slot + 1}`;
  }

  #closeTrade() {
    this.trade = null;
    this.$('#trade-modal').hidden = true;
  }

  #openTradeReview(m) {
    this.trade = { mode: 'review', peer: m.from, incoming: m };
    this.$('#trade-title').textContent = `${m.name ?? this.#tradePeerName(m.from)} offers a trade`;
    this.$('#trade-offer-head').textContent = `${m.name ?? this.#tradePeerName(m.from)} offers…`;
    const fill = (sel, terms) => {
      const ul = this.$(sel);
      ul.innerHTML = '';
      const entries = [...(terms?.mons ?? []), ...(terms?.items ?? [])];
      for (const x of entries) {
        const li = document.createElement('li');
        li.textContent = this.#termLabel(x);
        ul.append(li);
      }
      if (!entries.length) {
        const li = document.createElement('li');
        li.textContent = 'nothing';
        ul.append(li);
      }
    };
    fill('#trade-offer-list', m.give);
    fill('#trade-want-list', m.want);
    this.$('#trade-review').hidden = false;
    this.$('#trade-edit').hidden = true;
    this.$('#trade-modal').hidden = false;
  }

  /** @param {number} peer @param {object|null} prefill counter-offer seed */
  #openTradeEditor(peer, prefill = null) {
    this.trade = {
      mode: 'edit',
      peer,
      giveSel: prefill?.giveSel ?? new Set(),
      giveItems: prefill?.giveItems ?? [],
      wantMons: prefill?.wantMons ?? [],
      wantItems: prefill?.wantItems ?? [],
    };
    this.$('#trade-title').textContent = `Offer a trade to ${this.#tradePeerName(peer)}`;
    this.$('#trade-review').hidden = true;
    this.$('#trade-edit').hidden = false;
    this.$('#trade-modal').hidden = false;
    this.#renderTradeEdit();
  }

  /** Counter-offer: swap the incoming terms into an editable reverse offer —
   *  what they wanted becomes what I give (party slots matched by species),
   *  what they gave becomes what I want. */
  #counterPrefill(m) {
    const giveSel = new Set();
    for (const w of m.want?.mons ?? []) {
      const idx = this.myParty.findIndex((mon, i) => !giveSel.has(i) && mon.sp === w.sp);
      if (idx >= 0) giveSel.add(idx);
    }
    return {
      giveSel,
      giveItems: (m.want?.items ?? []).map((i) => ({ id: i.id, qty: i.qty })),
      wantMons: (m.give?.mons ?? []).map((g) => g.sp),
      wantItems: (m.give?.items ?? []).map((i) => ({ id: i.id, qty: i.qty })),
    };
  }

  #renderTradeEdit() {
    const st = this.trade;
    if (!st || st.mode !== 'edit') return;
    const picks = this.$('#trade-give-mons');
    picks.innerHTML = '';
    this.myParty.forEach((mon, idx) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `#${mon.sp} lv${mon.lv}`;
      b.dataset.idx = idx;
      b.classList.toggle('sel', st.giveSel.has(idx));
      b.onclick = () => {
        if (st.giveSel.has(idx)) st.giveSel.delete(idx);
        else st.giveSel.add(idx);
        this.#renderTradeEdit();
      };
      picks.append(b);
    });
    // Removable chips: clicking one deletes it from its backing state array.
    const chip = (ul, text, remove) => {
      const li = document.createElement('li');
      li.textContent = text;
      li.title = 'remove';
      li.onclick = () => {
        remove();
        this.#renderTradeEdit();
      };
      ul.append(li);
    };
    const giveUl = this.$('#trade-give-items');
    giveUl.innerHTML = '';
    st.giveItems.forEach((it, i) => chip(giveUl, `item #${it.id} ×${it.qty}`, () => st.giveItems.splice(i, 1)));
    const wantUl = this.$('#trade-want-edit');
    wantUl.innerHTML = '';
    st.wantMons.forEach((sp, i) => chip(wantUl, `Pokémon #${sp}`, () => st.wantMons.splice(i, 1)));
    st.wantItems.forEach((it, i) => chip(wantUl, `item #${it.id} ×${it.qty}`, () => st.wantItems.splice(i, 1)));
  }

  #wireTrade() {
    const st = () => this.trade;
    this.$('#trade-accept').onclick = () => {
      if (st()?.incoming) this.socket.send({ t: 'trade.accept', from: st().incoming.from });
      this.#closeTrade();
    };
    this.$('#trade-reject').onclick = () => {
      if (st()?.incoming) this.socket.send({ t: 'trade.reject', from: st().incoming.from });
      this.#closeTrade();
    };
    this.$('#trade-counter').onclick = () => {
      const m = st()?.incoming;
      if (!m) return this.#closeTrade();
      // Counter = reject + a fresh reverse offer (owner's spec).
      this.socket.send({ t: 'trade.reject', from: m.from });
      this.#openTradeEditor(m.from, this.#counterPrefill(m));
    };
    this.$('#trade-cancel').onclick = () => this.#closeTrade();
    this.$('#trade-send').onclick = () => {
      const s = st();
      if (!s || s.mode !== 'edit') return;
      const give = {
        items: s.giveItems,
        mons: [...s.giveSel].sort((a, b) => a - b)
          .filter((i) => this.myParty[i])
          .map((i) => ({ slot: i, sp: this.myParty[i].sp })),
      };
      const want = { items: s.wantItems, mons: s.wantMons.map((sp) => ({ sp })) };
      if (!give.items.length && !give.mons.length && !want.items.length && !want.mons.length) {
        this.#toast('⚠️ an empty trade has nothing to offer', { ttl: 5000 });
        return;
      }
      this.socket.send({ t: 'trade.offer', to: s.peer, give, want });
      this.log('trade', `trade offer sent to ${this.#tradePeerName(s.peer)}`);
      this.#toast('🔁 trade offer sent', { ttl: 5000 });
      this.#closeTrade();
    };
    // "+ item" / "+ Pokémon" rows
    const readInt = (sel, lo, hi) => {
      const v = Number(this.$(sel).value);
      return Number.isInteger(v) && v >= lo && v <= hi ? v : null;
    };
    this.$('#trade-add-item').onclick = () => {
      const id = readInt('#trade-give-item', 1, 0xffff);
      const qty = readInt('#trade-give-qty', 1, 999) ?? 1;
      if (id === null || !st()) return;
      st().giveItems.push({ id, qty });
      this.$('#trade-give-item').value = '';
      this.#renderTradeEdit();
    };
    this.$('#trade-add-want-mon').onclick = () => {
      const sp = readInt('#trade-want-species', 1, 0xffff);
      if (sp === null || !st()) return;
      st().wantMons.push(sp);
      this.$('#trade-want-species').value = '';
      this.#renderTradeEdit();
    };
    this.$('#trade-add-want-item').onclick = () => {
      const id = readInt('#trade-want-item', 1, 0xffff);
      const qty = readInt('#trade-want-qty', 1, 999) ?? 1;
      if (id === null || !st()) return;
      st().wantItems.push({ id, qty });
      this.$('#trade-want-item').value = '';
      this.#renderTradeEdit();
    };
  }

  // ---- team battles (docs/plans/TEAM-BATTLES.md §8) --------------------------

  /** The pale-grey tint over the shared battle while it's not your turn. */
  #setVeil(on, controller = null) {
    const veil = this.$('#battle-turn-veil');
    veil.hidden = !on;
    if (on && controller !== null) {
      const name = this.players.get(controller)?.name ?? `P${controller + 1}`;
      this.$('#veil-msg').textContent = `${name} is choosing…`;
    }
  }

  #renderTeamPanel() {
    const none = this.$('#team-none');
    const ul = this.$('#team-members');
    const actions = this.$('#team-actions');
    if (!none) return; // panel absent (old markup)
    ul.innerHTML = '';
    const has = Boolean(this.team);
    none.hidden = has;
    actions.hidden = !has;
    if (!has) return;
    for (const m of this.team.members) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${m.name}${m.slot === this.slot ? ' (you)' : ''}`;
      li.append(name);
      if (m.slot === this.team.leader) {
        const lead = document.createElement('span');
        lead.className = 'lead';
        lead.textContent = 'leader';
        li.append(lead);
      }
      const picks = document.createElement('span');
      picks.className = 'dur';
      picks.textContent = m.picks?.length
        ? `line-up: ${m.picks.map((i) => i + 1).join(',')}`
        : 'line-up: auto (top 3)';
      li.append(picks);
      ul.append(li);
    }
  }

  /** Interleaved A1,B1,(C1),A2,… preview — mirrors merge.js mergeLineupWire. */
  #mergedPreview() {
    if (!this.team) return [];
    const rows = this.team.members.map((m) => {
      const picks = (m.slot === this.slot ? this.teamPicks : m.picks) ?? null;
      const order = picks?.length
        ? picks
        : (m.party ?? []).map((mon, idx) => ({ idx, lv: mon.lv }))
          .sort((a, b) => b.lv - a.lv || a.idx - b.idx).slice(0, 3).map((x) => x.idx);
      return { m, order: order.filter((i) => m.party?.[i]).slice(0, 3) };
    });
    const merged = [];
    for (let rank = 0; rank < 3; rank++) {
      for (const { m, order } of rows) {
        if (order[rank] !== undefined) merged.push({ owner: m, mon: m.party[order[rank]] });
      }
    }
    return merged.slice(0, 6);
  }

  #renderTeamBuilder() {
    if (!this.team) return;
    if (!this.teamPicks) {
      this.teamPicks = [...(this.team.members.find((m) => m.slot === this.slot)?.picks ?? [])];
    }
    const rows = this.$('#team-rows');
    rows.innerHTML = '';
    for (const m of this.team.members) {
      const row = document.createElement('div');
      row.className = 'team-row';
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${m.name}${m.slot === this.slot ? ' (you — tap to pick)' : ''}`;
      row.append(who);
      const picksBox = document.createElement('div');
      picksBox.className = 'trade-picks';
      const mine = m.slot === this.slot;
      const activePicks = mine ? this.teamPicks : (m.picks ?? []);
      (m.party ?? []).forEach((mon, idx) => {
        const b = document.createElement('button');
        b.type = 'button';
        const rank = activePicks.indexOf(idx);
        b.textContent = `${rank >= 0 ? `${rank + 1}· ` : ''}#${mon.sp} lv${mon.lv}`;
        b.dataset.idx = idx;
        b.disabled = !mine;
        b.classList.toggle('sel', rank >= 0);
        if (mine) {
          b.onclick = () => {
            const at = this.teamPicks.indexOf(idx);
            if (at >= 0) this.teamPicks.splice(at, 1);
            else if (this.teamPicks.length < 3) this.teamPicks.push(idx);
            this.#renderTeamBuilder();
          };
        }
        picksBox.append(b);
      });
      row.append(picksBox);
      rows.append(row);
    }
    const mergedUl = this.$('#team-merged');
    mergedUl.innerHTML = '';
    for (const { owner, mon } of this.#mergedPreview()) {
      const li = document.createElement('li');
      li.textContent = `${owner.name}: #${mon.sp} lv${mon.lv}`;
      mergedUl.append(li);
    }
  }

  // ---- friends dropdown (left) — the mirror of the OPTIONS gear -------------

  #wireFriends() {
    const btn = this.$('#btn-friends');
    const panel = this.$('#friends-panel');
    if (!btn || !panel) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      panel.classList.toggle('open');
    };
    // Tapping the game (or anywhere outside the panel/button) closes it.
    document.addEventListener('pointerdown', (e) => {
      if (panel.classList.contains('open') && !e.target.closest('#friends-panel, #btn-friends')) {
        panel.classList.remove('open');
      }
    });
  }

  #wireTeam() {
    const builderBtn = this.$('#btn-team-builder');
    if (!builderBtn) return; // markup absent
    builderBtn.onclick = () => {
      this.teamPicks = null; // refresh from the latest team.update
      this.#renderTeamBuilder();
      this.$('#team-modal').hidden = false;
    };
    this.$('#btn-team-leave').onclick = () => this.socket.send({ t: 'team.leave' });
    this.$('#team-save').onclick = () => {
      this.socket.send({ t: 'team.lineup', picks: this.teamPicks ?? [] });
      this.$('#team-modal').hidden = true;
      this.log('team', 'line-up saved');
    };
    this.$('#team-close').onclick = () => {
      this.$('#team-modal').hidden = true;
    };
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
