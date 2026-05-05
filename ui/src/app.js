/**
 * DolbyX Web UI — Application logic
 *
 * WebSocket auto-connect/reconnect, state sync, SVG visualizer.
 * All interactions via event delegation. Keyboard accessible.
 */

import { initVisualizer, updateVisBars, setEqLevels, setKnobCallback } from './visualizer.js';

const PROFILES = ['Movie', 'Music', 'Game', 'Voice', 'Custom 1', 'Custom 2'];
const IEQ_MODES = ['Open', 'Rich', 'Focused', 'Manual'];

/* IEQ preset target curves (from ds1-default.xml) */
const IEQ_PRESETS = {
  0: [117,133,188,176,141,149,175,185,185,200,236,242,228,213,182,132,110,68,-27,-240],  // Open
  1: [67,95,172,163,168,201,189,242,196,221,192,186,168,139,102,57,35,9,-55,-235],        // Rich
  2: [-419,-112,75,116,113,160,165,80,61,79,98,121,64,70,44,-71,-33,-100,-238,-411],       // Focused
};

let ws = null;
let state = { profile: 1, power: 1, params: [], ieq: 3 };
let reconnectTimer = null;

/* Map IEQ values (-500..+500) to grid rows (0..48, center=24) */
function ieqToGrid(values) {
  return values.map(v => Math.round(24 + (v / 500) * 24));
}

/* Map grid row (0..48) to IEQ value (-500..+500) */
function gridToIeq(row) {
  return Math.round((row - 24) / 24 * 500);
}

/* ── WebSocket ────────────────────────────────────── */

function connect() {
  if (ws && ws.readyState <= 1) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    setConn('ok', 'Connected to DolbyX');
    send({ cmd: 'get_state' });
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  };

  ws.onclose = () => {
    setConn('err', 'Disconnected — reconnecting…');
    ws = null;
    if (!reconnectTimer) reconnectTimer = setInterval(connect, 2000);
  };

  ws.onerror = () => { if (ws) ws.close(); };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') { state = msg; render(); renderEq(); }
      if (msg.type === 'vis') { updateVisBars(msg.bands); }
    } catch (_) {}
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setConn(cls, text) {
  const el = document.getElementById('conn');
  el.className = 'conn ' + cls;
  el.textContent = text;
}

/* ── Render Controls ──────────────────────────────── */

function render() {
  const pwr = document.getElementById('pwr');
  pwr.className = state.power ? 'power' : 'power off';
  pwr.setAttribute('aria-pressed', String(!!state.power));

  const profEl = document.getElementById('profiles');
  profEl.innerHTML = PROFILES.map((name, i) =>
    `<button class="prof${i === state.profile ? ' active' : ''}"
            role="tab" aria-selected="${i === state.profile}"
            data-profile="${i}" tabindex="${i === state.profile ? 0 : -1}">${name}</button>`
  ).join('');

  document.querySelectorAll('.ctrl-row').forEach(row => {
    const en = parseInt(row.dataset.en);
    const amt = parseInt(row.dataset.amt);
    const isOn = (state.params[en] || 0) > 0;
    const val = state.params[amt] || 0;

    const slider = row.querySelector('.ctrl-slider');
    slider.min = row.dataset.min;
    slider.max = row.dataset.max;
    slider.value = val;
    row.querySelector('.ctrl-val').textContent = val;

    const toggle = row.querySelector('.toggle');
    toggle.className = isOn ? 'toggle on' : 'toggle';
    toggle.setAttribute('aria-pressed', String(isOn));
  });

  const ieqEl = document.getElementById('ieqModes');
  ieqEl.innerHTML = IEQ_MODES.map((name, i) =>
    `<button class="ieq-btn${i === state.ieq ? ' active' : ''}"
            role="radio" aria-checked="${i === state.ieq}"
            data-ieq="${i}" tabindex="${i === state.ieq ? 0 : -1}">${name}</button>`
  ).join('');

  document.getElementById('ieqLabel').textContent = state.ieq === 3
    ? 'Graphic EQ: Manual'
    : `Intelligent EQ: ${IEQ_MODES[state.ieq]}`;
}

/* ── Render EQ levels in visualizer ───────────────── */

function renderEq() {
  if (state.ieq >= 0 && state.ieq <= 2 && IEQ_PRESETS[state.ieq]) {
    setEqLevels(ieqToGrid(IEQ_PRESETS[state.ieq]));
  } else {
    // Manual mode: flat at center
    setEqLevels(new Array(20).fill(24));
  }
}

/* ── Event Delegation ─────────────────────────────── */

function init() {
  /* Initialize SVG visualizer */
  const visContainer = document.getElementById('visualizer');
  initVisualizer(visContainer);

  /* EQ knob drag callback */
  setKnobCallback((knobIndex, gridRow) => {
    // TODO: send graphic EQ band update to daemon
    // For now, this updates the SVG visually only
  });

  /* Power */
  document.getElementById('pwr').addEventListener('click', () =>
    send({ cmd: 'power', on: !state.power }));

  /* Reset */
  document.getElementById('resetBtn').addEventListener('click', () =>
    send({ cmd: 'reset_profile' }));

  /* Profiles */
  document.getElementById('profiles').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-profile]');
    if (btn) send({ cmd: 'set_profile', id: parseInt(btn.dataset.profile) });
  });

  /* IEQ modes */
  document.getElementById('ieqModes').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ieq]');
    if (btn) send({ cmd: 'set_ieq', preset: parseInt(btn.dataset.ieq) });
  });

  /* Toggle sliders */
  document.querySelectorAll('.ctrl-row').forEach(row => {
    const amt = parseInt(row.dataset.amt);
    const en = parseInt(row.dataset.en);
    const onVal = parseInt(row.dataset.on);

    row.querySelector('.ctrl-slider').addEventListener('input', (e) =>
      send({ cmd: 'set_param', index: amt, value: parseInt(e.target.value) }));

    const toggle = row.querySelector('.toggle');
    toggle.addEventListener('click', () => {
      send({ cmd: 'set_param', index: en, value: (state.params[en] || 0) > 0 ? 0 : onVal });
    });
    toggle.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle.click(); }
    });
  });

  connect();
  render();
  renderEq();
}

document.addEventListener('DOMContentLoaded', init);
