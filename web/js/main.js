import { Socket } from './net/socket.js';
import * as mailbox from './bridge/mailbox.js';
import { Bridge } from './bridge/bridge.js';
import { UI } from './ui/ui.js';
import { assertAdapter } from './emu/adapter.js';
import { DemoAdapter } from './emu/demo-adapter.js';

const $ = (sel) => document.querySelector(sel);
const ROM_URL = '/rom/mba.gba';

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
      $('#btn-join').disabled = false;
      $('#rom-status').textContent = 'Game build ready — served fresh from the host.';
    } else {
      $('#rom-status').textContent = 'Game build found, but this address cannot run it (see below).';
    }
  } else {
    $('#rom-status').textContent = 'No game build on the server yet (host: run the ROM build).';
  }
}

async function fetchRomFile() {
  const res = await fetch(ROM_URL);
  if (!res.ok) throw new Error('the server has no ROM build');
  const blob = await res.blob();
  return new File([blob], 'mba.gba');
}

// ---- game boot ---------------------------------------------------------------

async function start(mode, romFile = null) {
  $('#login').hidden = true;
  $('#stage').hidden = false;

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

  bridge.onStatus = (s) =>
    ui.setStatus('#chip-mailbox', `mailbox: ${s}`, s === 'attached' || s === 'game-ready');
  ui.setStatus('#chip-mode', mode === 'demo' ? 'demo mode' : 'mGBA', true);

  try {
    await adapter.init($('#screen'));
  } catch (err) {
    ui.log('error', String(err.message ?? err));
    ui.setStatus('#chip-mode', 'failed to start', false);
    return;
  }
  if (romFile) {
    try {
      await adapter.loadROM(romFile);
      ui.log('rom', `loaded ${romFile.name}`);
    } catch (err) {
      ui.log('error', String(err.message ?? err));
    }
  }

  socket.connect({ name: $('#name').value || undefined });

  wireGameControls(adapter, socket, ui);

  if (mode === 'demo') {
    $('#demo-controls').hidden = false;
    $('#btn-end-battle').onclick = () => adapter.endBattle(1);
  }
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

  // Pulse presses: at world speed >1x, even the quickest physical tap spans
  // dozens of emulated frames — past the games' menu auto-repeat threshold —
  // so menus cycle several entries per tap. A press therefore delivers a
  // short fixed burst of emulated frames (~8), and only re-engages as a real
  // hold if the finger/key is still down after HOLD_MS (so held-walking at
  // 4x still works; deliberate holds still auto-repeat in menus).
  const PULSE_EMU_FRAMES = 8;
  const HOLD_MS = 200;
  const startPress = (name) => {
    adapter.buttonDown?.(name);
    const speed = adapter.currentSpeed ?? 1;
    if (speed <= 1) return () => adapter.buttonUp?.(name);

    let down = true; // emulated button state
    let physical = true;
    const pulseMs = Math.max(16, (PULSE_EMU_FRAMES * 16.7) / speed);
    const pulse = setTimeout(() => {
      adapter.buttonUp?.(name);
      down = false;
    }, pulseMs);
    const repress = setTimeout(() => {
      if (physical) {
        adapter.buttonDown?.(name);
        down = true;
      }
    }, HOLD_MS);
    return () => {
      physical = false;
      clearTimeout(pulse);
      clearTimeout(repress);
      if (down) adapter.buttonUp?.(name);
    };
  };

  const activePresses = new Map(); // name -> release fn
  const pressDown = (name) => {
    if (activePresses.has(name)) return;
    activePresses.set(name, startPress(name));
  };
  const pressUp = (name) => {
    activePresses.get(name)?.();
    activePresses.delete(name);
  };

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
    let dx = e.clientX - (r.left + R);
    let dy = e.clientY - (r.top + R);
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

  // ---- control preferences: size slider, pad placement, stick toggle ----
  const applyScale = (pct) => touch.style.setProperty('--ps', String(pct / 100));
  const applyMode = (mode) => {
    wrap.classList.toggle('controls-below', mode === 'below');
    $('#btn-pad-mode').textContent = mode === 'below' ? 'Pads: below' : 'Pads: overlay';
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
  const inFullscreen = () =>
    Boolean(document.fullscreenElement) || wrap.classList.contains('fake-fullscreen');
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

  // ---- fullscreen options panel: the real controls move in and out, so
  // there's a single source of truth for their state and labels ----
  const optionsPanel = $('#options-panel');
  const padPrefs = $('#pad-prefs');
  const controlsBar = $('#controls-bar');
  const syncFullscreenUi = () => {
    if (inFullscreen()) {
      optionsPanel.append(padPrefs);
    } else {
      controlsBar.append(padPrefs);
      optionsPanel.classList.remove('open');
    }
  };
  $('#btn-options').onclick = (e) => {
    e.stopPropagation();
    optionsPanel.classList.toggle('open');
  };
  document.addEventListener('fullscreenchange', syncFullscreenUi);
  const fsObserver = new MutationObserver(syncFullscreenUi);
  fsObserver.observe(wrap, { attributes: true, attributeFilter: ['class'] });

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
  // what actually applies it — for everyone.
  const speedMenu = $('#speed-menu');
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

$('#btn-join').onclick = async () => {
  $('#btn-join').disabled = true;
  $('#btn-join').textContent = 'Loading…';
  try {
    await start('mgba', await fetchRomFile());
  } catch (err) {
    $('#btn-join').disabled = false;
    $('#btn-join').textContent = 'Join the game';
    $('#rom-status').textContent = String(err.message ?? err);
  }
};
$('#btn-demo').onclick = () => start('demo');
$('#rom').onchange = (e) => {
  const file = e.target.files?.[0];
  if (file) start('mgba', file);
};

initJoinScreen();
