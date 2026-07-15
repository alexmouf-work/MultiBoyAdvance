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
    $('#btn-battle').onclick = () => adapter.startEncounter();
    $('#btn-flag').onclick = () => adapter.setStoryFlag(0x2a1);
    $('#btn-end-battle').onclick = () => adapter.endBattle(1);
  }
}

// ---- fullscreen / speed / touch ------------------------------------------------

function wireGameControls(adapter, socket, ui) {
  // Touch pads appear automatically on touch devices, always in fullscreen.
  if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) {
    document.body.classList.add('touch');
  }

  for (const pad of document.querySelectorAll('.pad')) {
    const name = pad.dataset.btn;
    const down = (e) => {
      e.preventDefault();
      pad.classList.add('held');
      adapter.buttonDown?.(name);
    };
    const up = (e) => {
      e.preventDefault();
      pad.classList.remove('held');
      adapter.buttonUp?.(name);
    };
    pad.addEventListener('pointerdown', down);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
    pad.addEventListener('pointerleave', up);
    pad.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  const wrap = $('#gamewrap');
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

  // Shared speed: request goes to the server; the world's answer (speed msg,
  // also present in welcome) is what actually applies it — for everyone.
  for (const b of document.querySelectorAll('#speed button')) {
    b.onclick = () => socket.send({ t: 'speed', x: Number(b.dataset.x) });
  }
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
