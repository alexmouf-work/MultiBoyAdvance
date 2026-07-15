// DOM overlays: roster, status chips, event log, battle offers, teleport/PvP.
// Deliberately framework-free; elements carry stable ids/data attributes so
// the e2e suite can assert on them.

export class UI {
  constructor(socket, bridge, adapter) {
    this.socket = socket;
    this.bridge = bridge;
    this.adapter = adapter;
    this.slot = null;
    this.players = new Map(); // slot -> name
    this.$ = (sel) => document.querySelector(sel);
    this.#wire();
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
    const ul = this.$('#players');
    ul.innerHTML = '';
    for (const [slot, name] of [...this.players.entries()].sort((a, b) => a[0] - b[0])) {
      const li = document.createElement('li');
      li.dataset.slot = slot;
      const label = document.createElement('span');
      label.textContent = `P${slot + 1} ${name}${slot === this.slot ? ' (you)' : ''}`;
      li.append(label);
      if (slot !== this.slot) {
        const tp = document.createElement('button');
        tp.textContent = 'teleport';
        tp.dataset.action = 'tp';
        tp.onclick = () => this.socket.send({ t: 'tp', to: slot });
        const pvp = document.createElement('button');
        pvp.textContent = 'battle';
        pvp.dataset.action = 'pvp';
        pvp.onclick = () => this.socket.send({ t: 'pvp', to: slot });
        li.append(tp, pvp);
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
      this.players.set(m.slot, this.$('#name').value || `Player${m.slot + 1}`);
      for (const p of m.players) this.players.set(p.slot, p.name);
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
      this.players.set(m.slot, m.name);
      this.#renderPlayers();
      this.log('join', `P${m.slot + 1} ${m.name} joined`);
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
    for (const b of document.querySelectorAll('#speed button')) {
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
