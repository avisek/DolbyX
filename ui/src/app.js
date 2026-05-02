/**
 * DolbyX Web UI — Application logic
 *
 * WebSocket auto-connect/reconnect, state sync, keyboard accessible controls.
 */

const PROFILES = ['Movie', 'Music', 'Game', 'Voice', 'Custom 1', 'Custom 2'];
const IEQ_MODES = ['Open', 'Rich', 'Focused', 'Manual'];

let ws = null;
let state = {
  profile: 1,
  power: 1,
  params: [2,2,48,0,200,2,4,0,0,0,10,1,2,0,4,2,144,0,0,0],
  ieq: 3,
};
let reconnectTimer = null;

/* ── WebSocket ────────────────────────────────────── */

function connect() {
  if (ws && ws.readyState <= 1) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    setConn('ok', 'Connected to DolbyX');
    send({ cmd: 'get_state' });
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onclose = () => {
    setConn('err', 'Disconnected — reconnecting…');
    ws = null;
    if (!reconnectTimer) {
      reconnectTimer = setInterval(connect, 2000);
    }
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        state = msg;
        render();
      }
    } catch (err) {
      // ignore malformed
    }
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function setConn(cls, text) {
  const el = document.getElementById('conn');
  el.className = 'conn ' + cls;
  el.textContent = text;
}

/* ── Commands ─────────────────────────────────────── */

function togglePower() {
  send({ cmd: 'power', on: !state.power });
}

function setProfile(id) {
  send({ cmd: 'set_profile', id });
}

function setParam(index, value) {
  send({ cmd: 'set_param', index, value: parseInt(value) });
}

function setIEQ(preset) {
  send({ cmd: 'set_ieq', preset });
}

function resetProfile() {
  // set_profile re-applies defaults
  send({ cmd: 'set_profile', id: state.profile });
}

/* ── Render ───────────────────────────────────────── */

function render() {
  // Power
  const pwr = document.getElementById('pwr');
  pwr.className = state.power ? 'power' : 'power off';
  pwr.setAttribute('aria-pressed', state.power ? 'true' : 'false');

  // Profiles
  const profEl = document.getElementById('profiles');
  profEl.innerHTML = PROFILES.map((name, i) =>
    `<button class="prof${i === state.profile ? ' active' : ''}"
            role="tab" aria-selected="${i === state.profile}"
            tabindex="${i === state.profile ? 0 : -1}"
            onclick="setProfile(${i})">${name}</button>`
  ).join('');

  // Controls
  document.querySelectorAll('.ctrl-row').forEach(row => {
    const en = parseInt(row.dataset.en);
    const amt = parseInt(row.dataset.amt);
    const min = parseInt(row.dataset.min);
    const max = parseInt(row.dataset.max);
    const onVal = parseInt(row.dataset.on);
    const isOn = state.params[en] > 0;
    const val = state.params[amt];

    const slider = row.querySelector('.ctrl-slider');
    slider.min = min;
    slider.max = max;
    slider.value = val;

    row.querySelector('.ctrl-val').textContent = val;

    const toggle = row.querySelector('.toggle');
    toggle.className = isOn ? 'toggle on' : 'toggle';
    toggle.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  });

  // IEQ
  const ieqEl = document.getElementById('ieqModes');
  ieqEl.innerHTML = IEQ_MODES.map((name, i) =>
    `<button class="ieq-btn${i === state.ieq ? ' active' : ''}"
            role="radio" aria-checked="${i === state.ieq}"
            tabindex="${i === state.ieq ? 0 : -1}"
            onclick="setIEQ(${i})">${name}</button>`
  ).join('');

  const ieqLabel = state.ieq === 3 ? 'Graphic EQ: Manual'
    : `Intelligent EQ: ${IEQ_MODES[state.ieq]}`;
  document.getElementById('ieqLabel').textContent = ieqLabel;
}

/* ── Visualizer (placeholder — Phase 3) ───────────── */

function initVisualizer() {
  const canvas = document.getElementById('visCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let phase = 0;

  function draw() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const W = rect.width, H = rect.height;

    ctx.clearRect(0, 0, W, H);

    const bands = 20;
    const gap = 2;
    const bw = (W - (bands + 1) * gap) / bands;

    for (let i = 0; i < bands; i++) {
      const x = gap + i * (bw + gap);
      const level = 0.15 + 0.4 * (0.5 + 0.5 * Math.sin(i * 0.6 + phase));
      const bh = H * level;

      const grad = ctx.createLinearGradient(0, H - bh, 0, H);
      grad.addColorStop(0, '#00d4ff');
      grad.addColorStop(1, '#003850');
      ctx.fillStyle = grad;
      ctx.fillRect(x, H - bh, bw, bh);
    }

    phase += 0.08;
    requestAnimationFrame(draw);
  }

  draw();
}

/* ── Event Binding ────────────────────────────────── */

function init() {
  // Power
  document.getElementById('pwr').addEventListener('click', togglePower);

  // Reset
  document.getElementById('resetBtn').addEventListener('click', resetProfile);

  // Slider input events (live updates while dragging)
  document.querySelectorAll('.ctrl-row').forEach(row => {
    const amt = parseInt(row.dataset.amt);
    const en = parseInt(row.dataset.en);
    const onVal = parseInt(row.dataset.on);

    row.querySelector('.ctrl-slider').addEventListener('input', (e) => {
      setParam(amt, e.target.value);
    });

    row.querySelector('.toggle').addEventListener('click', () => {
      const isOn = state.params[en] > 0;
      setParam(en, isOn ? 0 : onVal);
    });

    // Keyboard: space/enter toggles
    row.querySelector('.toggle').addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        const isOn = state.params[en] > 0;
        setParam(en, isOn ? 0 : onVal);
      }
    });
  });

  initVisualizer();
  connect();
  render();
}

document.addEventListener('DOMContentLoaded', init);
