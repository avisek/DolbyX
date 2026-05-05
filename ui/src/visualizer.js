/**
 * DolbyX SVG Visualizer + Equalizer
 *
 * 7-layer SVG matching the DDP Android app:
 *   1. Background gradient
 *   2. Grid pattern (20 cols × 48 rows)
 *   3. Frequency amplitude bars (quantized to grid)
 *   4. EQ knob lines (5 glowing verticals)
 *   5. Applied EQ band levels (20 bright column lines)
 *   6. EQ knob handles (5 circles)
 *   7. EQ curve (Catmull-Rom spline)
 *
 * Pointer events on SVG container — X selects band, Y sets amplitude.
 */

const NS = 'http://www.w3.org/2000/svg';

const COLS = 20;       // frequency bands
const ROWS = 48;       // vertical quantization steps
const KNOBS = 5;       // EQ control points
const KNOB_BANDS = [0, 5, 10, 15, 19]; // which bands have knobs

/* Colors */
const COL_BAR_DIM   = 'rgba(0, 160, 200, 0.25)';
const COL_BAR_BRIGHT = 'rgba(0, 210, 255, 0.7)';
const COL_EQ_LINE   = 'rgba(0, 210, 255, 0.35)';
const COL_EQ_CURVE  = '#00d4ff';
const COL_EQ_GLOW   = 'rgba(0, 210, 255, 0.4)';
const COL_HANDLE    = '#00d4ff';
const COL_HANDLE_RING = 'rgba(0, 210, 255, 0.3)';
const COL_GRID_LINE = 'rgba(60, 90, 120, 0.15)';
const COL_GRID_LINE_H = 'rgba(60, 90, 120, 0.08)';

/* State */
let svgEl = null;
let cellW = 0, cellH = 0;
let svgW = 0, svgH = 0;

/* Data (updated from WebSocket) */
let visBands = new Array(COLS).fill(0);     // 0..ROWS amplitude per band
let eqLevels = new Array(COLS).fill(24);    // 0..ROWS EQ level per band (center=24)
let knobValues = new Array(KNOBS).fill(24); // knob positions in grid rows

/* DOM references for fast updates */
let barEls = [];          // dim bars
let eqLevelEls = [];      // bright level lines
let knobLineEls = [];     // vertical knob lines
let knobCircleEls = [];   // knob handle circles
let knobGlowEls = [];     // knob outer glow circles
let eqCurveEl = null;     // curve path
let dragging = -1;        // which knob (-1 = none)

/* ── SVG element helpers ──────────────────────────── */

function el(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function g(id) {
  return el('g', { id });
}

/* ── Catmull-Rom spline through points ────────────── */

function catmullRom(points) {
  if (points.length < 2) return '';
  const pts = [points[0], ...points, points[points.length - 1]];
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/* ── Build the SVG ────────────────────────────────── */

export function initVisualizer(container) {
  const rect = container.getBoundingClientRect();
  svgW = rect.width;
  svgH = rect.height;
  cellW = svgW / COLS;
  cellH = svgH / ROWS;

  const svg = el('svg', {
    width: '100%', height: '100%',
    viewBox: `0 0 ${svgW} ${svgH}`,
    preserveAspectRatio: 'none',
  });
  svgEl = svg;

  /* ── Defs ─────────────────────────────────────── */
  const defs = el('defs', {});

  // Background gradient: dark navy bottom-center → black top edges
  const bgGrad = el('radialGradient', {
    id: 'bg-grad', cx: '50%', cy: '100%', r: '80%',
    fx: '50%', fy: '100%',
  });
  bgGrad.appendChild(el('stop', { offset: '0%', 'stop-color': '#0a1628' }));
  bgGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#050a10' }));
  defs.appendChild(bgGrad);

  // Vertical line gradient (fades at top and bottom)
  const lineGrad = el('linearGradient', {
    id: 'line-fade', x1: '0', y1: '0', x2: '0', y2: '1',
  });
  lineGrad.appendChild(el('stop', { offset: '0%', 'stop-color': COL_EQ_LINE, 'stop-opacity': '0' }));
  lineGrad.appendChild(el('stop', { offset: '20%', 'stop-color': COL_EQ_LINE, 'stop-opacity': '1' }));
  lineGrad.appendChild(el('stop', { offset: '80%', 'stop-color': COL_EQ_LINE, 'stop-opacity': '1' }));
  lineGrad.appendChild(el('stop', { offset: '100%', 'stop-color': COL_EQ_LINE, 'stop-opacity': '0' }));
  defs.appendChild(lineGrad);

  // Glow filter for curve and handles
  const glow = el('filter', { id: 'glow', x: '-50%', y: '-50%', width: '200%', height: '200%' });
  const blur = el('feGaussianBlur', { stdDeviation: '3', result: 'blur' });
  const merge = el('feMerge', {});
  merge.appendChild(el('feMergeNode', { in: 'blur' }));
  merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(blur);
  glow.appendChild(merge);
  defs.appendChild(glow);

  svg.appendChild(defs);

  /* ── Layer 1: Background ──────────────────────── */
  const bgGroup = g('layer-bg');
  bgGroup.appendChild(el('rect', {
    x: 0, y: 0, width: svgW, height: svgH, fill: 'url(#bg-grad)',
  }));

  // Grid lines
  for (let c = 0; c <= COLS; c++) {
    bgGroup.appendChild(el('line', {
      x1: c * cellW, y1: 0, x2: c * cellW, y2: svgH,
      stroke: COL_GRID_LINE, 'stroke-width': 0.5,
    }));
  }
  for (let r = 0; r <= ROWS; r++) {
    bgGroup.appendChild(el('line', {
      x1: 0, y1: r * cellH, x2: svgW, y2: r * cellH,
      stroke: COL_GRID_LINE_H, 'stroke-width': 0.5,
    }));
  }
  svg.appendChild(bgGroup);

  /* ── Layer 3: Frequency bars (dim) ────────────── */
  const barsGroup = g('layer-bars');
  barEls = [];
  for (let i = 0; i < COLS; i++) {
    const bar = el('rect', {
      x: i * cellW + 1, y: svgH, width: cellW - 2, height: 0,
      fill: COL_BAR_DIM, rx: 0,
    });
    barEls.push(bar);
    barsGroup.appendChild(bar);
  }
  svg.appendChild(barsGroup);

  /* ── Layer 4: EQ knob lines (5 glowing verticals) */
  const linesGroup = g('layer-knob-lines');
  knobLineEls = [];
  for (let k = 0; k < KNOBS; k++) {
    const band = KNOB_BANDS[k];
    const cx = (band + 0.5) * cellW;
    const line = el('line', {
      x1: cx, y1: 0, x2: cx, y2: svgH,
      stroke: 'url(#line-fade)', 'stroke-width': 1.5,
    });
    knobLineEls.push(line);
    linesGroup.appendChild(line);
  }
  svg.appendChild(linesGroup);

  /* ── Layer 5: Applied EQ band levels (20 bright lines) */
  const eqGroup = g('layer-eq-levels');
  eqLevelEls = [];
  for (let i = 0; i < COLS; i++) {
    const cx = (i + 0.5) * cellW;
    const levelLine = el('line', {
      x1: cx - cellW * 0.35, y1: svgH / 2,
      x2: cx + cellW * 0.35, y2: svgH / 2,
      stroke: COL_BAR_BRIGHT, 'stroke-width': 2, 'stroke-linecap': 'round',
    });
    eqLevelEls.push(levelLine);
    eqGroup.appendChild(levelLine);
  }
  svg.appendChild(eqGroup);

  /* ── Layer 7: EQ curve ────────────────────────── */
  const curveGroup = g('layer-eq-curve');
  eqCurveEl = el('path', {
    d: '', fill: 'none', stroke: COL_EQ_CURVE,
    'stroke-width': 2, 'stroke-linecap': 'round',
    filter: 'url(#glow)', opacity: '0.9',
  });
  curveGroup.appendChild(eqCurveEl);
  svg.appendChild(curveGroup);

  /* ── Layer 6: EQ knob handles (5 circles) ─────── */
  const handlesGroup = g('layer-handles');
  knobCircleEls = [];
  knobGlowEls = [];
  for (let k = 0; k < KNOBS; k++) {
    const band = KNOB_BANDS[k];
    const cx = (band + 0.5) * cellW;
    const cy = svgH / 2;

    // Outer glow ring
    const glowCircle = el('circle', {
      cx, cy, r: 12, fill: 'none',
      stroke: COL_HANDLE_RING, 'stroke-width': 6,
    });
    knobGlowEls.push(glowCircle);
    handlesGroup.appendChild(glowCircle);

    // Inner circle
    const circle = el('circle', {
      cx, cy, r: 7, fill: '#0a1628',
      stroke: COL_HANDLE, 'stroke-width': 2.5,
    });
    knobCircleEls.push(circle);
    handlesGroup.appendChild(circle);
  }
  svg.appendChild(handlesGroup);

  /* ── Pointer events on SVG container ──────────── */
  svg.addEventListener('pointerdown', onPointerDown);
  svg.addEventListener('pointermove', onPointerMove);
  svg.addEventListener('pointerup', onPointerUp);
  svg.addEventListener('pointerleave', onPointerUp);
  svg.style.touchAction = 'none';
  svg.style.cursor = 'crosshair';

  container.innerHTML = '';
  container.appendChild(svg);

  // Initial draw
  updateEqDisplay();
}

/* ── Coordinate helpers ───────────────────────────── */

function svgPoint(e) {
  const rect = svgEl.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / rect.width * svgW,
    y: (e.clientY - rect.top) / rect.height * svgH,
  };
}

function yToRow(y) {
  return Math.round(Math.max(0, Math.min(ROWS, (svgH - y) / cellH)));
}

function rowToY(row) {
  return svgH - row * cellH;
}

function xToKnob(x) {
  // Find nearest knob band
  let best = 0, bestDist = Infinity;
  for (let k = 0; k < KNOBS; k++) {
    const cx = (KNOB_BANDS[k] + 0.5) * cellW;
    const d = Math.abs(x - cx);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return best;
}

/* ── Pointer event handlers ───────────────────────── */

let onKnobChange = null; // callback: (knobIndex, gridRow) => void

function onPointerDown(e) {
  e.preventDefault();
  const pt = svgPoint(e);
  dragging = xToKnob(pt.x);
  svgEl.setPointerCapture(e.pointerId);
  handleDrag(pt);
}

function onPointerMove(e) {
  if (dragging < 0) return;
  e.preventDefault();
  const pt = svgPoint(e);
  // Allow swipe to different knob
  dragging = xToKnob(pt.x);
  handleDrag(pt);
}

function onPointerUp(e) {
  if (dragging >= 0) {
    svgEl.releasePointerCapture(e.pointerId);
    dragging = -1;
  }
}

function handleDrag(pt) {
  const row = yToRow(pt.y);
  knobValues[dragging] = row;
  updateEqDisplay();
  if (onKnobChange) onKnobChange(dragging, row);
}

/* ── Update visual display ────────────────────────── */

function updateEqDisplay() {
  // Interpolate 5 knob values → 20 band EQ levels
  interpolateKnobs();

  // Update each band's EQ level line position
  for (let i = 0; i < COLS; i++) {
    const y = rowToY(eqLevels[i]);
    const cx = (i + 0.5) * cellW;
    eqLevelEls[i].setAttribute('y1', y);
    eqLevelEls[i].setAttribute('y2', y);
    eqLevelEls[i].setAttribute('x1', cx - cellW * 0.35);
    eqLevelEls[i].setAttribute('x2', cx + cellW * 0.35);
  }

  // Update knob handle positions
  for (let k = 0; k < KNOBS; k++) {
    const band = KNOB_BANDS[k];
    const y = rowToY(eqLevels[band]);
    const cx = (band + 0.5) * cellW;
    knobCircleEls[k].setAttribute('cy', y);
    knobGlowEls[k].setAttribute('cy', y);
    knobCircleEls[k].setAttribute('cx', cx);
    knobGlowEls[k].setAttribute('cx', cx);

    // Update knob vertical line
    knobLineEls[k].setAttribute('x1', cx);
    knobLineEls[k].setAttribute('x2', cx);
  }

  // Update EQ curve (Catmull-Rom through all 20 band levels)
  const points = [];
  for (let i = 0; i < COLS; i++) {
    points.push([(i + 0.5) * cellW, rowToY(eqLevels[i])]);
  }
  eqCurveEl.setAttribute('d', catmullRom(points));
}

function interpolateKnobs() {
  // Linear interpolation between 5 knob positions → 20 band levels
  for (let i = 0; i < COLS; i++) {
    // Find surrounding knobs
    let lo = 0, hi = KNOBS - 1;
    for (let k = 0; k < KNOBS - 1; k++) {
      if (i >= KNOB_BANDS[k] && i <= KNOB_BANDS[k + 1]) {
        lo = k; hi = k + 1; break;
      }
    }
    const t = KNOB_BANDS[hi] === KNOB_BANDS[lo] ? 0 :
      (i - KNOB_BANDS[lo]) / (KNOB_BANDS[hi] - KNOB_BANDS[lo]);
    eqLevels[i] = Math.round(knobValues[lo] + t * (knobValues[hi] - knobValues[lo]));
  }
}

/* ── Update frequency bars from processor data ────── */

export function updateVisBars(bands) {
  for (let i = 0; i < COLS && i < bands.length; i++) {
    // Quantize to grid
    const rows = Math.round(Math.max(0, Math.min(ROWS, bands[i])));
    visBands[i] = rows;
    const h = rows * cellH;
    barEls[i].setAttribute('y', svgH - h);
    barEls[i].setAttribute('height', h);
  }
}

/* ── Set EQ levels from external data (IEQ presets) ── */

export function setEqLevels(levels) {
  for (let i = 0; i < COLS && i < levels.length; i++) {
    eqLevels[i] = Math.round(Math.max(0, Math.min(ROWS, levels[i])));
  }
  // Snap knobs to their band levels
  for (let k = 0; k < KNOBS; k++) {
    knobValues[k] = eqLevels[KNOB_BANDS[k]];
  }
  updateEqDisplay();
}

/* ── Set callback for knob changes ────────────────── */

export function setKnobCallback(cb) {
  onKnobChange = cb;
}
