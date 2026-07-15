// DOM overlays: roster, status chips, event log, battle offers, teleport/PvP.
// Deliberately framework-free; elements carry stable ids/data attributes so
// the e2e suite can assert on them.

const PLAYER_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f5a623', '#8e4ec6', '#00b3c2', '#d6409f', '#846358'];

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export class UI {
  constructor(socket, bridge, adapter) {
    this.socket = socket;
    this.bridge = bridge;
    this.adapter = adapter;
    this.slot = null;
    this.players = new Map(); // slot -> {name, joinedAt (local clock)}
    this.$ = (sel) => document.querySelector(sel);
    this.#wire();
    setInterval(() => this.#tickDurations(), 1000);
  }

  #tickDurations() {
    for (const li of this.$('#players')?.querySelectorAll('li') ?? []) {
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
      this.#renderPlayers();
      this.log('welcome', `joined as P${m.slot + 1} · ${m.flags.length} world flags known`);
      if (m.speed > 1) this.#applySpeed(m.speed);
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
      this.#renderPlayers();
      this.log('leave', `P${m.slot + 1} left`);
    });
    s.on('ghost', (m) => {
      if (m.s !== 255) this.log('ghost', `P${m.slot + 1} @ map ${m.g}.${m.n} (${m.x},${m.y})`);
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
    s.on('error', (m) => this.log('error', m.msg));
  }

  #applySpeed(x) {
    this.adapter.setSpeed?.(x);
    const btn = document.querySelector('#btn-speed');
    if (btn) btn.textContent = `⚡ ${x}×`;
    for (const b of document.querySelectorAll('#speed-menu button')) {
      b.classList.toggle('on', Number(b.dataset.x) === x);
    }
  }

  #showOffer(m) {
    const box = this.$('#offers');
    const div = document.createElement('div');
    div.className = 'offer';
    div.dataset.sid = m.sid;
    div.innerHTML = `<span>P${m.from + 1} is battling (opp ${m.opp})</span>`;
    const join = document.createElement('button');
    join.textContent = 'Join battle';
    join.dataset.action = 'join-battle';
    join.onclick = () => {
      this.bridge.joinBattle(m.sid);
      this.log('battle.join', `joined ${m.sid}`);
      div.remove();
    };
    div.append(join);
    box.append(div);
    setTimeout(() => div.remove(), m.ttl ?? 10_000);
  }

  #showPvpChallenge(m) {
    const box = this.$('#offers');
    const div = document.createElement('div');
    div.className = 'offer';
    div.innerHTML = `<span>P${m.from + 1} ${m.name} challenges you!</span>`;
    const accept = document.createElement('button');
    accept.textContent = 'Accept';
    accept.dataset.action = 'pvp-accept';
    accept.onclick = () => {
      this.socket.send({ t: 'pvp.accept', from: m.from });
      div.remove();
    };
    div.append(accept);
    box.append(div);
    setTimeout(() => div.remove(), 15_000);
  }
}
