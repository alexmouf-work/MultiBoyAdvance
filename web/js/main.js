import { Socket } from './net/socket.js';
import * as mailbox from './bridge/mailbox.js';
import { Bridge } from './bridge/bridge.js';
import { UI } from './ui/ui.js';
import { assertAdapter } from './emu/adapter.js';
import { DemoAdapter } from './emu/demo-adapter.js';

const $ = (sel) => document.querySelector(sel);

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

  // Demo-only controls
  if (mode === 'demo') {
    $('#demo-controls').hidden = false;
    $('#btn-battle').onclick = () => adapter.startEncounter();
    $('#btn-flag').onclick = () => adapter.setStoryFlag(0x2a1);
    $('#btn-end-battle').onclick = () => adapter.endBattle(1);
  }
}

$('#btn-demo').onclick = () => start('demo');
$('#rom').onchange = (e) => {
  const file = e.target.files?.[0];
  if (file) start('mgba', file);
};
