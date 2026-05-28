/**
 * DolbyX SVG Visualizer + Equalizer
 *
 * Data flow (round-trip through processor):
 *   1. Pointer drag → 5-band knob values
 *   2. Interpolate 5 → 20 band gains
 *   3. Send 20-band gains to daemon via WebSocket
 *   4. Daemon sends to processor (libdseffect.so)
 *   5. Processor returns applied 20-band gains
 *   6. Daemon broadcasts to UI
 *   7. UI renders from received data (not from pointer values)
 *
 * Grid quantization: ONLY on frequency amplitude bars.
 * EQ elements (levels, curve, handles) move smoothly.
 */

const NS = 'http://www.w3.org/2000/svg'

const COLS = 20
const ROWS = 48
const KNOBS = 5
const KNOB_BANDS = [0, 5, 10, 15, 19]

/* ── SVG element helper ───────────────────────────── */

function el(tag, attrs) {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

/* ── Catmull-Rom spline ───────────────────────────── */

function catmullRom(points) {
  if (points.length < 2) return ''
  const pts = [points[0], ...points, points[points.length - 1]]
  let d = `M${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1],
      p1 = pts[i],
      p2 = pts[i + 1],
      p3 = pts[i + 2]
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`
  }
  return d
}

/* ── State ────────────────────────────────────────── */

let svgEl = null
let cellW = 0,
  cellH = 0,
  svgW = 0,
  svgH = 0

/* DOM references */
let barEls = []
let eqLevelEls = []
let knobLineEls = []
let knobCircleEls = []
let knobGlowEls = []
let eqCurveEl = null

/* Current displayed EQ levels (from processor, 20 bands, smooth Y coords) */
let displayedEqY = new Array(COLS).fill(0)

/* Drag state */
let dragging = -1
let onGEQChange = null

/* ── Coordinate conversion ────────────────────────── */

/* EQ gain value (-500..+500) → Y pixel (smooth, not quantized) */
function gainToY(gain) {
  /* Map -500 → bottom, +500 → top */
  return svgH * (1 - (gain + 500) / 1000)
}

/* Y pixel → EQ gain value */
function yToGain(y) {
  return Math.round((1 - y / svgH) * 1000 - 500)
}

/* Find nearest knob to X position */
function xToKnob(x) {
  let best = 0,
    bestDist = Infinity
  for (let k = 0; k < KNOBS; k++) {
    const cx = (KNOB_BANDS[k] + 0.5) * cellW
    const d = Math.abs(x - cx)
    if (d < bestDist) {
      bestDist = d
      best = k
    }
  }
  return best
}

function svgPoint(e) {
  const rect = svgEl.getBoundingClientRect()
  return {
    x: ((e.clientX - rect.left) / rect.width) * svgW,
    y: ((e.clientY - rect.top) / rect.height) * svgH,
  }
}

/* ── Build SVG ────────────────────────────────────── */

export function initVisualizer(container) {
  const rect = container.getBoundingClientRect()
  svgW = rect.width
  svgH = rect.height
  if (svgW < 10) svgW = 680
  if (svgH < 10) svgH = 200
  cellW = svgW / COLS
  cellH = svgH / ROWS

  const svg = el('svg', {
    width: '100%',
    height: '100%',
    viewBox: `0 0 ${svgW} ${svgH}`,
  })
  svgEl = svg

  /* Defs */
  const defs = el('defs', {})

  const bgGrad = el('radialGradient', {
    id: 'bg-grad',
    cx: '50%',
    cy: '100%',
    r: '80%',
    fx: '50%',
    fy: '100%',
  })
  bgGrad.appendChild(el('stop', { offset: '0%', 'stop-color': '#0a1628' }))
  bgGrad.appendChild(el('stop', { offset: '100%', 'stop-color': '#050a10' }))
  defs.appendChild(bgGrad)

  const lineGrad = el('linearGradient', {
    id: 'line-fade',
    x1: '0',
    y1: '0',
    x2: '0',
    y2: '1',
  })
  lineGrad.appendChild(
    el('stop', {
      offset: '0%',
      'stop-color': 'rgba(0,210,255,0.35)',
      'stop-opacity': '0',
    }),
  )
  lineGrad.appendChild(
    el('stop', {
      offset: '15%',
      'stop-color': 'rgba(0,210,255,0.35)',
      'stop-opacity': '1',
    }),
  )
  lineGrad.appendChild(
    el('stop', {
      offset: '85%',
      'stop-color': 'rgba(0,210,255,0.35)',
      'stop-opacity': '1',
    }),
  )
  lineGrad.appendChild(
    el('stop', {
      offset: '100%',
      'stop-color': 'rgba(0,210,255,0.35)',
      'stop-opacity': '0',
    }),
  )
  defs.appendChild(lineGrad)

  const glow = el('filter', {
    id: 'glow',
    x: '-50%',
    y: '-50%',
    width: '200%',
    height: '200%',
  })
  glow.appendChild(el('feGaussianBlur', { stdDeviation: '3', result: 'blur' }))
  const merge = el('feMerge', {})
  merge.appendChild(el('feMergeNode', { in: 'blur' }))
  merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }))
  glow.appendChild(merge)
  defs.appendChild(glow)

  svg.appendChild(defs)

  /* Layer 1: Background + grid */
  const bg = el('g', { id: 'layer-bg' })
  bg.appendChild(
    el('rect', {
      x: 0,
      y: 0,
      width: svgW,
      height: svgH,
      fill: 'url(#bg-grad)',
    }),
  )
  for (let c = 0; c <= COLS; c++)
    bg.appendChild(
      el('line', {
        x1: c * cellW,
        y1: 0,
        x2: c * cellW,
        y2: svgH,
        stroke: 'rgba(60,90,120,0.15)',
        'stroke-width': 0.5,
      }),
    )
  for (let r = 0; r <= ROWS; r++)
    bg.appendChild(
      el('line', {
        x1: 0,
        y1: r * cellH,
        x2: svgW,
        y2: r * cellH,
        stroke: 'rgba(60,90,120,0.08)',
        'stroke-width': 0.5,
      }),
    )
  svg.appendChild(bg)

  /* Layer 3: Frequency bars (quantized to grid) */
  const bars = el('g', { id: 'layer-bars' })
  barEls = []
  for (let i = 0; i < COLS; i++) {
    const bar = el('rect', {
      x: i * cellW + 1,
      y: svgH,
      width: cellW - 2,
      height: 0,
      fill: 'rgba(0,160,200,0.25)',
    })
    barEls.push(bar)
    bars.appendChild(bar)
  }
  svg.appendChild(bars)

  /* Layer 4: EQ knob lines (5 glowing verticals) */
  const lines = el('g', { id: 'layer-knob-lines' })
  knobLineEls = []
  for (let k = 0; k < KNOBS; k++) {
    const cx = (KNOB_BANDS[k] + 0.5) * cellW
    const line = el('line', {
      x1: cx,
      y1: 0,
      x2: cx,
      y2: svgH,
      stroke: 'url(#line-fade)',
      'stroke-width': 1.5,
    })
    knobLineEls.push(line)
    lines.appendChild(line)
  }
  svg.appendChild(lines)

  /* Layer 5: Applied EQ band levels (20 bright lines) */
  const eqg = el('g', { id: 'layer-eq-levels' })
  eqLevelEls = []
  for (let i = 0; i < COLS; i++) {
    const cx = (i + 0.5) * cellW
    const line = el('line', {
      x1: cx - cellW * 0.35,
      y1: svgH / 2,
      x2: cx + cellW * 0.35,
      y2: svgH / 2,
      stroke: 'rgba(0,210,255,0.7)',
      'stroke-width': 2,
      'stroke-linecap': 'round',
    })
    eqLevelEls.push(line)
    eqg.appendChild(line)
  }
  svg.appendChild(eqg)

  /* Layer 7: EQ curve */
  const curve = el('g', { id: 'layer-eq-curve' })
  eqCurveEl = el('path', {
    d: '',
    fill: 'none',
    stroke: '#00d4ff',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    filter: 'url(#glow)',
    opacity: '0.9',
  })
  curve.appendChild(eqCurveEl)
  svg.appendChild(curve)

  /* Layer 6: EQ knob handles (5 circles) */
  const handles = el('g', { id: 'layer-handles' })
  knobCircleEls = []
  knobGlowEls = []
  for (let k = 0; k < KNOBS; k++) {
    const cx = (KNOB_BANDS[k] + 0.5) * cellW
    const glowC = el('circle', {
      cx,
      cy: svgH / 2,
      r: 12,
      fill: 'none',
      stroke: 'rgba(0,210,255,0.3)',
      'stroke-width': 6,
    })
    knobGlowEls.push(glowC)
    handles.appendChild(glowC)

    const circle = el('circle', {
      cx,
      cy: svgH / 2,
      r: 7,
      fill: '#0a1628',
      stroke: '#00d4ff',
      'stroke-width': 2.5,
    })
    knobCircleEls.push(circle)
    handles.appendChild(circle)
  }
  svg.appendChild(handles)

  /* Pointer events on SVG container */
  svg.addEventListener('pointerdown', onDown)
  svg.addEventListener('pointermove', onMove)
  svg.addEventListener('pointerup', onUp)
  svg.addEventListener('pointerleave', onUp)
  svg.style.touchAction = 'none'
  svg.style.cursor = 'crosshair'

  container.innerHTML = ''
  container.appendChild(svg)

  /* Initialize display at center */
  for (let i = 0; i < COLS; i++) displayedEqY[i] = svgH / 2
  renderEqFromY()
}

/* ── Pointer handlers (produce 5-band → 20-band → send to daemon) ── */

function onDown(e) {
  e.preventDefault()
  const pt = svgPoint(e)
  dragging = xToKnob(pt.x)
  svgEl.setPointerCapture(e.pointerId)
  sendDrag(pt)
}

function onMove(e) {
  if (dragging < 0) return
  e.preventDefault()
  const pt = svgPoint(e)
  dragging = xToKnob(pt.x)
  sendDrag(pt)
}

function onUp(e) {
  if (dragging >= 0) {
    svgEl.releasePointerCapture(e.pointerId)
    dragging = -1
  }
}

function sendDrag(pt) {
  /* Clamp Y to SVG bounds */
  const y = Math.max(0, Math.min(svgH, pt.y))
  const gain = yToGain(y)

  /* Get current 5 knob gain values, update dragged one */
  const knobGains = KNOB_BANDS.map((b) => yToGain(displayedEqY[b]))
  knobGains[dragging] = gain

  /* Interpolate 5 → 20 */
  const bands20 = interpolate5to20(knobGains)

  /* Send to daemon (round-trip: daemon → processor → daemon → UI) */
  if (onGEQChange) onGEQChange(bands20)
}

function interpolate5to20(knobGains) {
  const result = new Array(COLS)
  for (let i = 0; i < COLS; i++) {
    let lo = 0,
      hi = KNOBS - 1
    for (let k = 0; k < KNOBS - 1; k++) {
      if (i >= KNOB_BANDS[k] && i <= KNOB_BANDS[k + 1]) {
        lo = k
        hi = k + 1
        break
      }
    }
    const range = KNOB_BANDS[hi] - KNOB_BANDS[lo]
    const t = range > 0 ? (i - KNOB_BANDS[lo]) / range : 0
    result[i] = Math.round(knobGains[lo] + t * (knobGains[hi] - knobGains[lo]))
  }
  return result
}

/* ── Render from data (called when state arrives from daemon) ─────── */

/*
 * Update EQ display from 20-band gain values returned by the processor.
 * This is the ONLY place that sets EQ visual positions.
 * Gains are in ds1 format: -500..+500 (approx).
 */
export function setEqFromGains(gains20) {
  for (let i = 0; i < COLS && i < gains20.length; i++) {
    displayedEqY[i] = gainToY(gains20[i])
  }
  renderEqFromY()
}

function renderEqFromY() {
  /* EQ level lines (smooth Y, no quantization) */
  for (let i = 0; i < COLS; i++) {
    const y = displayedEqY[i]
    const cx = (i + 0.5) * cellW
    eqLevelEls[i].setAttribute('y1', y)
    eqLevelEls[i].setAttribute('y2', y)
    eqLevelEls[i].setAttribute('x1', cx - cellW * 0.35)
    eqLevelEls[i].setAttribute('x2', cx + cellW * 0.35)
  }

  /* Knob handles: snap to their band's Y position (smooth) */
  for (let k = 0; k < KNOBS; k++) {
    const band = KNOB_BANDS[k]
    const y = displayedEqY[band]
    const cx = (band + 0.5) * cellW
    knobCircleEls[k].setAttribute('cy', y)
    knobGlowEls[k].setAttribute('cy', y)
    knobCircleEls[k].setAttribute('cx', cx)
    knobGlowEls[k].setAttribute('cx', cx)
    knobLineEls[k].setAttribute('x1', cx)
    knobLineEls[k].setAttribute('x2', cx)
  }

  /* EQ curve: Catmull-Rom through all 20 points (smooth) */
  const points = []
  for (let i = 0; i < COLS; i++) {
    points.push([(i + 0.5) * cellW, displayedEqY[i]])
  }
  eqCurveEl.setAttribute('d', catmullRom(points))
}

/* ── Update frequency bars (quantized to grid) ────── */

export function updateVisBars(bands) {
  for (let i = 0; i < COLS && i < bands.length; i++) {
    /* Quantize to integer number of grid cells */
    const rows = Math.max(0, Math.min(ROWS, Math.round(bands[i])))
    const h = rows * cellH
    barEls[i].setAttribute('y', svgH - h)
    barEls[i].setAttribute('height', h)
  }
}

/* ── Callback registration ────────────────────────── */

export function setGEQCallback(cb) {
  onGEQChange = cb
}
