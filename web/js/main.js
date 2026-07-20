import { Socket } from './net/socket.js';
import * as mailbox from './bridge/mailbox.js';
import { Bridge } from './bridge/bridge.js';
import { UI } from './ui/ui.js';
import { assertAdapter } from './emu/adapter.js';
import { DemoAdapter } from './emu/demo-adapter.js';
import { mapName } from './data/map-names.js';

const $ = (sel) => document.querySelector(sel);
const ROM_URL = '/rom/mba.gba';
const ROM_CACHE = 'mba-rom-v1'; // browser-side ROM store, keyed by build hash
let joinReady = false; // ROM present + secure context

// ---- join screen state -------------------------------------------------------

async function serverHasRom() {
  try {
    const res = await fetch(ROM_URL, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function initJoinScreen() {
  const secure = crossOriginIsolated;
  if (!secure) $('#ctx-warning').hidden = false;

  // Demo mode is a development harness, not a product feature: reachable only
  // via ?demo=1 (the e2e suite uses it), invisible to players.
  if (new URLSearchParams(location.search).has('demo')) $('#btn-demo').hidden = false;

  if (await serverHasRom()) {
    if (secure) {
      joinReady = true;
      $('#btn-join').disabled = false;
      $('#rom-status').textContent = 'Game build ready — served fresh from the host.';
    } else {
      $('#rom-status').textContent = 'Game build found, but this address cannot run it (see below).';
    }
  } else {
    $('#rom-status').textContent = 'No game build on the server yet (host: run the ROM build).';
  }

  await loadRoster();
  setInterval(() => {
    if (!$('#login').hidden) loadRoster();
  }, 10_000);
}

// ---- returning trainers -------------------------------------------------------

function fmtAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** The server remembers every trainer; one click resumes as them. */
async function loadRoster() {
  let users;
  try {
    users = (await (await fetch('/api/users')).json()).users;
  } catch {
    return; // server unreachable; leave the section as-is
  }
  $('#returning').hidden = !users?.length;
  if (!users?.length) return;

  const list = $('#user-list');
  list.innerHTML = '';
  for (const u of users) {
    const chip = document.createElement('button');
    chip.className = 'user-chip';
    chip.dataset.name = u.name;
    const where = mapName(u.g, u.n);
    const dot = document.createElement('span');
    dot.className = `dot ${u.online ? 'on' : 'off'}`;
    const name = document.createElement('span');
    name.className = 'uname';
    name.textContent = u.name;
    const loc = document.createElement('span');
    loc.className = 'uloc';
    if (u.online) {
      chip.disabled = true;
      loc.textContent = where ? `playing now · ${where}` : 'playing now';
    } else {
      chip.disabled = !joinReady;
      const ago = u.lastSeenAt ? fmtAgo(Date.now() - u.lastSeenAt) : '';
      loc.textContent = [where, ago].filter(Boolean).join(' · ') || 'never played';
      chip.onclick = () => joinNow(u.name);
    }
    chip.append(dot, name, loc);
    list.append(chip);
  }
}

// The ROM is a fixed build artifact — byte-identical for every player until the
// host rebuilds it, and fully separate from game state (that lives in the .sav).
// So we keep it in the browser's Cache Storage keyed by its content hash: a
// returning player boots instantly with no download, and we only re-fetch when
// the host ships a new build (new hash). A per-session "diff" wouldn't help —
// the ROM never changes as you play; when it does change, it's a new binary.
async function fetchRomFile(onStatus) {
  const info = await fetch('/api/rom-info').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const hash = info?.sha256 || null;
  const cache = hash && 'caches' in window ? await caches.open(ROM_CACHE).catch(() => null) : null;
  const key = hash ? `${ROM_URL}?v=${hash}` : null;

  if (cache && key) {
    const hit = await cache.match(key);
    if (hit) {
      onStatus?.('Loading the game from cache…');
      return new File([await hit.blob()], 'mba.gba');
    }
  }

  onStatus?.('Downloading the game…');
  const res = await fetch(ROM_URL);
  if (!res.ok) throw new Error('the server has no ROM build');
  const blob = await readBlobWithProgress(res, info?.size, onStatus);

  if (cache && key) {
    try {
      await cache.put(key, new Response(blob, { headers: { 'content-type': 'application/octet-stream' } }));
      // Only the current build is worth keeping — evict any older cached ROMs.
      const keep = new Request(key).url;
      for (const req of await cache.keys()) if (req.url !== keep) await cache.delete(req);
    } catch { /* caching is a nicety; a boot never depends on it */ }
  }
  return new File([blob], 'mba.gba');
}

// Stream the body so the boot overlay can show real progress on the one slow
// path (first load or a fresh build). Falls back to a plain blob when the length
// is unknown or the browser can't stream the response.
async function readBlobWithProgress(res, total, onStatus) {
  if (!res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onStatus?.(`Downloading the game… ${Math.min(99, Math.round((got / total) * 100))}%`);
  }
  return new Blob(chunks, { type: 'application/octet-stream' });
}

/** Fingerprint the downloaded ROM and compare against the server's own hash —
 *  catches stale builds and corrupted transfers/storage in one line of log. */
async function verifyRom(romFile, ui) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await romFile.arrayBuffer());
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const short = hash.slice(0, 12);
    ui.log('rom', `ROM fingerprint ${short} · ${(romFile.size / 1024 / 1024).toFixed(1)} MiB`);
    const info = await (await fetch('/api/rom-info')).json().catch(() => null);
    if (info?.sha256 && info.sha256 !== hash) {
      ui.log('error', `ROM download corrupted (server has ${info.sha256.slice(0, 12)}) — refresh the page`);
    }
  } catch {
    // fingerprinting is diagnostics only; never block the boot
  }
}

// ---- save persistence (browser IndexedDB + server copy) ----------------------

const saveUrl = (name) => `/api/save/${encodeURIComponent(name)}`;

/** Pull the trainer's server-side save into the emulator FS before boot.
 *  Server copy wins (it's refreshed every autosave while playing anywhere);
 *  with no server copy, whatever IndexedDB restored locally stands. */
async function restoreSave(adapter, name, ui) {
  try {
    const res = await fetch(saveUrl(name));
    if (!res.ok) return;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length) return;
    await adapter.writeSave(bytes);
    ui.log('save', `progress for ${name} restored from the server — pick CONTINUE`);
  } catch {
    // offline server copy is a nicety; local FS still applies
  }
}

/** Push the current .sav to IndexedDB + the server. One flight at a time. */
function makeSaveSync(adapter, name, ui) {
  let busy = false;
  return async () => {
    if (busy || !adapter.readSave) return;
    busy = true;
    try {
      // Give the core a beat to flush the flash write into its FS.
      await new Promise((r) => setTimeout(r, 300));
      const bytes = adapter.readSave();
      if (bytes?.length) {
        await adapter.persistFS?.(); // browser copy
        await fetch(saveUrl(name), { method: 'PUT', body: bytes }); // server copy
        ui.log('save', 'progress saved (browser + server)');
      }
    } catch (err) {
      ui.log('error', `save sync failed: ${err.message ?? err}`);
    } finally {
      busy = false;
    }
  };
}

// ---- boot progress overlay ---------------------------------------------------

function showLoading(msg) {
  $('#loading').hidden = false;
  $('#loading-msg').textContent = msg;
  $('#loading-msg').classList.remove('err');
  $('#loading-back').hidden = true;
}
function hideLoading() {
  $('#loading').hidden = true;
}
function loadingError(msg) {
  $('#loading').hidden = false;
  const el = $('#loading-msg');
  el.textContent = msg;
  el.classList.add('err');
  $('#loading .spinner').style.display = 'none';
  $('#loading-back').hidden = false;
}

// ---- game boot ---------------------------------------------------------------

async function start(mode, romFile = null) {
  let adapter;
  if (mode === 'demo') {
    adapter = new DemoAdapter();
  } else {
    const { MgbaAdapter } = await import('./emu/mgba-adapter.js');
    adapter = new MgbaAdapter();
  }
  assertAdapter(adapter);

  const socket = new Socket();
  const bridge = new Bridge(adapter, socket);
  const ui = new UI(socket, bridge, adapter);
  window.mba = { adapter, socket, bridge, ui }; // console + e2e access
  window.mbaMailbox = mailbox;

  bridge.onStatus = (s) => {
    ui.setStatus('#chip-mailbox', `mailbox: ${s}`, s === 'attached' || s === 'game-ready');
    // The game is visibly live once the bridge attaches — drop the overlay.
    if (s === 'attached' || s === 'game-ready') hideLoading();
  };
  ui.setStatus('#chip-mode', mode === 'demo' ? 'demo mode' : 'mGBA', true);

  try {
    showLoading('Starting the emulator…');
    await adapter.init($('#screen'));
  } catch (err) {
    ui.log('error', String(err.message ?? err));
    ui.setStatus('#chip-mode', 'failed to start', false);
    loadingError(String(err.message ?? err));
    return;
  }
  const playerName = $('#name').value.trim() || 'Player';
  if (romFile) {
    try {
      if (mode !== 'demo') await verifyRom(romFile, ui);
      if (mode !== 'demo') { showLoading('Loading your progress…'); await restoreSave(adapter, playerName, ui); }
      showLoading('Booting the game…');
      await adapter.loadROM(romFile);
      ui.log('rom', `loaded ${romFile.name}`);
      // Watchdog: a healthy netcode ROM plants its mailbox within seconds of
      // boot. Never finding it means the build is stale/corrupt, or this
      // browser's emulator storage is damaged from an earlier crash.
      setTimeout(() => {
        if (bridge.status === 'searching') {
          const msg = 'game netcode never started — the ROM build on the server may be '
            + 'stale/corrupt (host: re-run setup), or this browser\'s emulator storage is '
            + 'damaged (use "Reset emulator storage" in the Debug panel)';
          ui.log('error', msg);
          bridge.onLog(`WATCHDOG: ${msg}`);
        }
      }, 20_000);
    } catch (err) {
      ui.log('error', String(err.message ?? err));
    }
  }
  // Typing in the console/name fields must not reach the emulator (it grabs
  // keyboard input globally); suspend its input while any text field is focused.
  if (adapter.setKeyboardCapture) {
    document.addEventListener('focusin', (e) => {
      if (e.target.matches('input[type="text"], input[type="number"], input:not([type]), textarea')) {
        adapter.setKeyboardCapture(false);
      }
    });
    document.addEventListener('focusout', () => adapter.setKeyboardCapture(true));
  }
  // Every successful in-game save (the ~10s autosave or a manual SAVE) gets
  // mirrored to IndexedDB and the server.
  bridge.onSaved = makeSaveSync(adapter, playerName, ui);

  showLoading('Connecting to the world…');
  socket.connect({ name: $('#name').value || undefined });

  wireGameControls(adapter, socket, ui);

  if (mode === 'demo') {
    $('#demo-controls').hidden = false;
    $('#btn-end-battle').onclick = () => adapter.endBattle(1);
    hideLoading(); // demo has no real mailbox to attach — reveal immediately
  }
  // Fallback: if the mailbox never reports (e.g. a stall), don't trap the
  // player behind the overlay forever — the Debug panel surfaces the problem.
  setTimeout(hideLoading, 25_000);
}

// ---- fullscreen / speed / touch / prefs ------------------------------------------

const prefs = {
  get: (k, d) => localStorage.getItem(`mba.${k}`) ?? d,
  set: (k, v) => localStorage.setItem(`mba.${k}`, v),
};

function wireGameControls(adapter, socket, ui) {
  const wrap = $('#gamewrap');
  const touch = $('#touch');

  // Touch pads appear automatically on touch devices, always in fullscreen.
  if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
    document.body.classList.add('touch');
  }

  const pressDown = (name) => adapter.buttonDown?.(name);
  const pressUp = (name) => adapter.buttonUp?.(name);

  for (const pad of document.querySelectorAll('.pad')) {
    const name = pad.dataset.btn;
    const down = (e) => {
      e.preventDefault();
      pad.classList.add('held');
      pressDown(name);
    };
    const up = (e) => {
      e.preventDefault();
      pad.classList.remove('held');
      pressUp(name);
    };
    pad.addEventListener('pointerdown', down);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('pointerleave', up);
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---- joystick mode: angle -> 8-way digital D-pad presses ----
  const base = $('#stick-base');
  const knob = $('#stick-knob');
  let stickHeld = new Set();
  const stickApply = (next) => {
    for (const d of stickHeld) if (!next.has(d)) adapter.buttonUp?.(d);
    for (const d of next) if (!stickHeld.has(d)) adapter.buttonDown?.(d);
    stickHeld = next;
  };
  const stickMove = (e) => {
    const r = base.getBoundingClientRect();
    const R = r.width / 2;
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    // In the mobile-overlay portrait layout the whole #gamewrap is rotated 90°,
    // so a viewport delta is rotated relative to the stick's own axes — the knob
    // would fly off sideways and the 8-way mapping would be wrong. Undo the
    // gamewrap transform's linear part to read the delta in the frame the player
    // actually sees (no-op when there's no transform: below/windowed/landscape).
    const tf = getComputedStyle(wrap).transform;
    if (tf && tf !== 'none') {
      const m = new DOMMatrix(tf);
      const det = m.a * m.d - m.b * m.c;
      if (det) {
        const lx = (dx * m.d - dy * m.c) / det;
        const ly = (-dx * m.b + dy * m.a) / det;
        dx = lx;
        dy = ly;
      }
    }
    const len = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(len, R * 0.72);
    knob.style.transform = `translate(${(dx / len) * clamped}px, ${(dy / len) * clamped}px)`;
    const next = new Set();
    if (len > R * 0.28) {
      // 8-way: use per-axis thresholds so diagonals hold two directions
      if (dx / len > 0.42) next.add('Right');
      if (dx / len < -0.42) next.add('Left');
      if (dy / len > 0.42) next.add('Down');
      if (dy / len < -0.42) next.add('Up');
    }
    stickApply(next);
  };
  const stickEnd = () => {
    base.classList.remove('live');
    knob.style.transform = '';
    stickApply(new Set());
  };
  base.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    base.setPointerCapture(e.pointerId);
    base.classList.add('live');
    stickMove(e);
  });
  base.addEventListener('pointermove', (e) => {
    if (base.classList.contains('live')) stickMove(e);
  });
  base.addEventListener('pointerup', stickEnd);
  base.addEventListener('pointercancel', stickEnd);

  // ---- immersive UI (fullscreen OR mobile overlay): the pad prefs + logout
  // live in the pop-out OPTIONS panel so they're reachable without a controls
  // bar; outside immersive they sit in the bar below the game. ----
  const optionsPanel = $('#options-panel');
  const padPrefs = $('#pad-prefs');
  const controlsBar = $('#controls-bar');
  const logoutBtn = $('#btn-logout');
  const speedMenu = $('#speed-menu');
  const closeSpeedMenu = () => { speedMenu.hidden = true; };
  const inFullscreen = () =>
    Boolean(document.fullscreenElement) || wrap.classList.contains('fake-fullscreen');
  // On phones BOTH pad modes fill the screen (the controls bar is hidden behind
  // the fixed game frame), so the prefs + logout have to live in the pop-out
  // OPTIONS panel for either mode — not just overlay. On desktop, "below" keeps
  // the normal bar, so it's only immersive there when actually fullscreen.
  const immersive = () =>
    inFullscreen() ||
    (isTouch() &&
      (wrap.classList.contains('mobile-overlay') || wrap.classList.contains('controls-below')));
  const syncImmersiveUi = () => {
    // A reparent or mode switch must never strand the speed selector open: its
    // hidden state would invert the next toggle, so the button reads as dead
    // until an unrelated outside-tap resets it (the "logout then cancel" fix).
    closeSpeedMenu();
    if (immersive()) {
      optionsPanel.append(padPrefs, logoutBtn);
    } else {
      controlsBar.append(logoutBtn, padPrefs);
      optionsPanel.classList.remove('open');
    }
  };

  // ---- control preferences: size slider, pad placement, stick toggle ----
  const isTouch = () => document.body.classList.contains('touch');
  const applyScale = (pct) => touch.style.setProperty('--ps', String(pct / 100));
  const applyMode = (mode) => {
    wrap.classList.toggle('controls-below', mode === 'below');
    // On phones, overlay mode is an immersive landscape view (game rotated to
    // fill the screen, controls floating on top). Below mode stays windowed.
    wrap.classList.toggle('mobile-overlay', mode !== 'below' && isTouch());
    $('#btn-pad-mode').textContent = mode === 'below' ? 'Pads: below' : 'Pads: overlay';
    syncImmersiveUi();
  };
  const applyStick = (stick) => {
    $('#joystick').hidden = stick !== 'stick';
    $('#dpad').hidden = stick === 'stick';
    $('#btn-stick').textContent = stick === 'stick' ? 'Joystick' : 'D-pad';
    if (stick !== 'stick') stickEnd();
  };

  const scale = Number(prefs.get('padScale', '100'));
  $('#pad-scale').value = scale;
  applyScale(scale);
  applyMode(prefs.get('padMode', 'overlay'));
  applyStick(prefs.get('padStick', 'dpad'));

  $('#pad-scale').addEventListener('input', (e) => {
    applyScale(Number(e.target.value));
    prefs.set('padScale', e.target.value);
  });
  $('#btn-pad-mode').onclick = () => {
    const next = wrap.classList.contains('controls-below') ? 'overlay' : 'below';
    applyMode(next);
    prefs.set('padMode', next);
  };
  $('#btn-stick').onclick = () => {
    const next = $('#joystick').hidden ? 'stick' : 'dpad';
    applyStick(next);
    prefs.set('padStick', next);
  };

  // ---- fullscreen (+ keyboard mapping while in it) ----
  $('#btn-fullscreen').onclick = async () => {
    document.body.classList.add('touch'); // controls are wanted in fullscreen
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wrap.requestFullscreen();
    } catch {
      wrap.classList.toggle('fake-fullscreen'); // iPhone: no element fullscreen API
    }
  };
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) wrap.classList.remove('fake-fullscreen');
  });

  // Fullscreen key map: WASD move, Z=A, X=B, Enter=Select, C=Start.
  // Capture phase + stopPropagation so the emulator's own bindings don't
  // double-fire on the same keys.
  const FS_KEYS = { w: 'Up', a: 'Left', s: 'Down', d: 'Right', z: 'A', ' ': 'A', x: 'B', Enter: 'Select', c: 'Start' };
  const fsKey = (down) => (e) => {
    if (!inFullscreen()) return;
    const name = FS_KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!name) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (down) pressDown(name);
    else pressUp(name);
  };
  window.addEventListener('keydown', fsKey(true), true);
  window.addEventListener('keyup', fsKey(false), true);

  // ---- OPTIONS panel open/close + keep it synced with immersive state ----
  $('#btn-options').onclick = (e) => {
    e.stopPropagation();
    optionsPanel.classList.toggle('open');
    closeSpeedMenu(); // the selector always starts collapsed when the panel opens/closes
  };
  document.addEventListener('fullscreenchange', syncImmersiveUi);
  const fsObserver = new MutationObserver(syncImmersiveUi);
  fsObserver.observe(wrap, { attributes: true, attributeFilter: ['class'] });
  syncImmersiveUi(); // initial placement (applyMode ran before this wiring)

  // ---- sidebar drawer ----
  const sidebar = $('#sidebar');
  const startOpen = prefs.get('sidebar', matchMedia('(min-width: 900px)').matches ? 'open' : 'closed');
  sidebar.classList.toggle('open', startOpen === 'open');
  $('#sidebar-tab').onclick = () => {
    const open = sidebar.classList.toggle('open');
    prefs.set('sidebar', open ? 'open' : 'closed');
  };

  // Shared speed: a button that opens the 4-speed selector. The request goes
  // to the server; the world's answer (speed msg, also present in welcome) is
  // what actually applies it — for everyone. (speedMenu/closeSpeedMenu are
  // declared up in the immersive block so mode switches can reset the selector.)
  $('#btn-speed').onclick = (e) => {
    e.stopPropagation();
    speedMenu.hidden = !speedMenu.hidden;
  };
  for (const b of speedMenu.querySelectorAll('button')) {
    b.onclick = () => {
      socket.send({ t: 'speed', x: Number(b.dataset.x) });
      speedMenu.hidden = true;
    };
  }
  document.addEventListener('pointerdown', (e) => {
    if (!speedMenu.hidden && !e.target.closest('#speed-ctl')) speedMenu.hidden = true;
  });
}

// ---- entry ---------------------------------------------------------------------

async function joinNow(name = null) {
  if (name) $('#name').value = name;
  // Move straight to the stage with a progress overlay — no button left
  // spinning on the login screen while a multi-MB ROM downloads.
  $('#login').hidden = true;
  $('#stage').hidden = false;
  showLoading('Preparing the game…');
  try {
    await start('mgba', await fetchRomFile((m) => showLoading(m)));
  } catch (err) {
    loadingError(String(err.message ?? err));
  }
}

$('#btn-join').onclick = () => joinNow();
$('#btn-demo').onclick = async () => {
  $('#login').hidden = true;
  $('#stage').hidden = false;
  showLoading('Starting demo…');
  await start('demo');
};
$('#rom').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $('#login').hidden = true;
  $('#stage').hidden = false;
  showLoading('Booting the game…');
  await start('mgba', file);
};

// Logout / back-to-start: a full reload is the clean teardown (emulator core,
// socket, save sync all reset). Progress is already saved server-side.
const goHome = () => location.reload();
$('#loading-back').onclick = goHome;
$('#btn-logout').onclick = () => {
  if (confirm('Return to the start screen? Your progress is saved.')) goHome();
};

initJoinScreen();
