// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One widget per (kind, access) combo, metadata-driven — no per-param
 * code (mechanical prefix rules like `*nb` gating live in wiring /
 * BandWidgets). Discrete commits = ack-then-apply; drags / scrubs =
 * optimistic live per step (MasterControls' precedent). `mode` picks
 * the long-array treatment: 'strip' (variant A bars) or 'cells'
 * (variant B/C grids).
 */
import { For, type Component, type JSX } from 'solid-js'
import { onValue, unitLabel, type ParameterDef } from '../lib/parameters'
import { rawToDisplay } from '../lib/units'
import {
  Aobg,
  Bars,
  Cells,
  DynPlot,
  bandSeat,
  coarseStep,
  display,
  fineStep,
  toRaw,
} from './BandWidgets'
import ScrubInput from './ScrubInput'
import { commitParam, effectiveCount, liveParam, paramValues } from './wiring'

export type ArrayMode = 'strip' | 'cells'

/** Raw head value. */
const head = (def: ParameterDef): number => paramValues(def)[0] ?? 0

// — Scalar widgets —

const Toggle: Component<{ def: ParameterDef }> = (props) => (
  <button
    type="button"
    class="adv-toggle"
    role="switch"
    aria-checked={head(props.def) !== 0}
    aria-label={props.def.label}
    onClick={() => {
      commitParam(props.def, [
        head(props.def) === 0 ? onValue(props.def.kind) : 0,
      ])
    }}
  >
    <span class="adv-toggle__track" aria-hidden="true">
      <span class="adv-toggle__thumb" />
    </span>
  </button>
)

/** 0 / 1 / 2 segmented — DAP_FEATURE_OFF / ON / AUTO (`tristate.on`
 * is what a curated *toggle* writes for "on"; the panel exposes all
 * three states explicitly). */
const Tristate: Component<{ def: ParameterDef }> = (props) => (
  <div class="adv-tristate" role="group" aria-label={props.def.label}>
    <For each={['Off', 'On', 'Auto']}>
      {(label, i) => (
        <button
          type="button"
          class="adv-tristate__seg"
          classList={{ 'adv-tristate__seg--active': head(props.def) === i() }}
          aria-pressed={head(props.def) === i()}
          onClick={() => {
            commitParam(props.def, [i()])
          }}
        >
          {label}
        </button>
      )}
    </For>
  </div>
)

/** The scrub/type value box every scalar shares — unit inside the box,
 * pointer-lock scrub, live while scrubbing, commit on release / Enter. */
const ValueBox: Component<{ def: ParameterDef }> = (props) => (
  <ScrubInput
    label={props.def.label}
    unit={unitLabel(props.def.kind)}
    value={() => display(props.def, head(props.def))}
    min={rawToDisplay(props.def.min, props.def.frac_bits)}
    max={rawToDisplay(props.def.max, props.def.frac_bits)}
    coarse={coarseStep(props.def)}
    fine={fineStep(props.def)}
    onLive={(value) => {
      liveParam(props.def, [toRaw(props.def, value)])
    }}
    onCommit={(value) => {
      commitParam(props.def, [toRaw(props.def, value)])
    }}
  />
)

/** Slider + editable value box — decibel, degrees, small-range int. */
const Slider: Component<{ def: ParameterDef }> = (props) => (
  <div class="adv-slider">
    <input
      type="range"
      class="adv-slider__input"
      aria-label={props.def.label}
      min={rawToDisplay(props.def.min, props.def.frac_bits)}
      max={rawToDisplay(props.def.max, props.def.frac_bits)}
      step={rawToDisplay(1, props.def.frac_bits)}
      value={display(props.def, head(props.def))}
      onInput={(event) => {
        liveParam(props.def, [
          toRaw(props.def, event.currentTarget.valueAsNumber),
        ])
      }}
    />
    <ValueBox def={props.def} />
  </div>
)

// — Read-only widgets —

/** ReadOnly-Static, from the snapshot `readouts` map — every param the
 * same opaque rendering, no per-param formatting. */
const StaticReadout: Component<{ def: ParameterDef }> = (props) => {
  const text = (): string =>
    paramValues(props.def)
      .slice(0, effectiveCount(props.def))
      .map((raw) => String(display(props.def, raw)))
      .join(', ')
  return <span class="adv-readout">{text()}</span>
}

/** Unknown combo fallback — opaque int display. */
const Opaque: Component<{ def: ParameterDef }> = (props) => (
  <span class="adv-readout">{paramValues(props.def).join(', ')}</span>
)

// — Dispatch —

/** Writable band array in the variant's treatment. */
const ArrayWidget: Component<{ def: ParameterDef; mode: ArrayMode }> = (
  props,
) =>
  props.mode === 'cells' ? (
    <Cells seat={bandSeat(props.def)} />
  ) : (
    <Bars seat={bandSeat(props.def)} />
  )

/** Dispatches a `(kind, access)` combo to its widget. `def` is static
 * per card, so plain setup-time branching stays sound. */
const WidgetFactory: Component<{ def: ParameterDef; mode?: ArrayMode }> = (
  props,
): JSX.Element => {
  const def = props.def
  const mode = props.mode ?? 'strip'
  if (def.access === 'read_only_dynamic') return <DynPlot def={def} />
  if (def.access === 'read_only_static') return <StaticReadout def={def} />
  const kind = def.kind
  if (typeof kind === 'object') {
    if ('tristate' in kind) return <Tristate def={def} />
    // decibel — scalar slider; band arrays fall through below.
    if (def.length === 1) return <Slider def={def} />
    return <ArrayWidget def={def} mode={mode} />
  }
  if (kind === 'aobg_channel_major') return <Aobg def={def} mode={mode} />
  if (def.length > 1) {
    // per_band / frequency_hz arrays — the variant's array treatment.
    if (kind === 'per_band' || kind === 'frequency_hz') {
      return <ArrayWidget def={def} mode={mode} />
    }
    console.warn(`advanced: no widget for ${def.name} (${kind}[])`)
    return <Opaque def={def} />
  }
  if (kind === 'toggle') return <Toggle def={def} />
  if (kind === 'degrees') return <Slider def={def} />
  if (kind === 'frequency_hz') return <ValueBox def={def} />
  if (kind === 'integer') {
    // Small range → slider; wide (band counts, 20 kHz) → value box.
    return def.max - def.min <= 32 ? (
      <Slider def={def} />
    ) : (
      <ValueBox def={def} />
    )
  }
  console.warn(`advanced: no widget for ${def.name} (${kind})`)
  return <Opaque def={def} />
}

export default WidgetFactory
