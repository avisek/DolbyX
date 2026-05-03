/**
 * DolbyX Web UI — Application logic
 *
 * All user interactions use event delegation (no inline onclick handlers).
 * WebSocket auto-connect/reconnect. Keyboard accessible.
 */

const PROFILES = ['Movie', 'Music', 'Game', 'Voice', 'Custom 1', 'Custom 2'];
const IEQ_MODES = ['Open', 'Rich', 'Focused', 'Manual'];

const TOGGLES = [
  { label: 'Volume Leveler',       en: 7,  amt: 6,  min: 0, max: 10,  onVal: 1 },
  { label: 'Dialogue Enhancer',    en: 11, amt: 12, min: 0, max: 16,  onVal: 1 },
  { label: 'Surround Virtualizer', en: 1,  amt: 2,  min: 0, max: 192, onVal: 2 },
];

let ws = null;
let state = { profile: 1, power: 1, params: [], ieq: 3 };
let reconnectTimer = null;

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
      if (msg.type === 'state') { state = msg; render(); }
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

/* ── Render ───────────────────────────────────────── */

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

/* ── Event Delegation ─────────────────────────────── */

function init() {
  document.getElementById('pwr').addEventListener('click', () =>
    send({ cmd: 'power', on: !state.power }));

  document.getElementById('resetBtn').addEventListener('click', () =>
    send({ cmd: 'set_profile', id: state.profile }));

  document.getElementById('profiles').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-profile]');
    if (btn) send({ cmd: 'set_profile', id: parseInt(btn.dataset.profile) });
  });

  document.getElementById('ieqModes').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ieq]');
    if (btn) send({ cmd: 'set_ieq', preset: parseInt(btn.dataset.ieq) });
  });

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
}

document.addEventListener('DOMContentLoaded', init);
