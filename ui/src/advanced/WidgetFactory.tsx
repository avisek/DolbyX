// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One widget per (kind, access) combo, metadata-driven — no per-param
 * code, no layout policy (skins lay out the control region). EVERY
 * long array (`length > 1` — writable, read-only, live vis, `aobg`)
 * renders the one BandArray DOM; scalars pick toggle / tristate /
 * slider+box / box / readout. Discrete commits = ack-then-apply;
 * drags / scrubs = optimistic live per step.
 */
import { For, type Component, type JSX } from 'solid-js'
import { onValue, unitLabel, type ParameterDef } from '../lib/parameters'
import { rawToDisplay } from '../lib/units'
import BandArray, { coarseStep, display, fineStep, toRaw } from './BandArray'
import ScrubInput from './ScrubInput'
import Slider from './Slider'
import { commitParam, liveParam, paramValues } from './wiring'

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
 * vertical pointer-lock scrub, live while scrubbing, commit on
 * release / Enter. */
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

/** Custom slider + editable value box — decibel, degrees, small-range
 * int. Structure only; the skin lays the pair out. */
const SliderCombo: Component<{ def: ParameterDef }> = (props) => (
  <>
    <Slider
      label={props.def.label}
      unit={unitLabel(props.def.kind)}
      value={() => display(props.def, head(props.def))}
      min={rawToDisplay(props.def.min, props.def.frac_bits)}
      max={rawToDisplay(props.def.max, props.def.frac_bits)}
      fine={fineStep(props.def)}
      coarse={coarseStep(props.def)}
      onLive={(value) => {
        liveParam(props.def, [toRaw(props.def, value)])
      }}
      onCommit={(value) => {
        commitParam(props.def, [toRaw(props.def, value)])
      }}
    />
    <ValueBox def={props.def} />
  </>
)

// — Read-only scalars —

/** Read-only scalar — opaque display, no per-param formatting. */
const Readout: Component<{ def: ParameterDef }> = (props) => (
  <span class="adv-readout">{String(display(props.def, head(props.def)))}</span>
)

// — Dispatch —

/** Dispatches a `(kind, access)` combo to its widget. `def` is static
 * per card, so plain setup-time branching stays sound. */
const WidgetFactory: Component<{ def: ParameterDef }> = (
  props,
): JSX.Element => {
  const def = props.def
  // Kind decides structure: every long array is the one band DOM
  // (access only gates the inputs inside).
  if (def.length > 1) return <BandArray def={def} />
  if (def.access === 'read_only_static' || def.access === 'read_only_dynamic') {
    return <Readout def={def} />
  }
  const kind = def.kind
  if (typeof kind === 'object') {
    if ('tristate' in kind) return <Tristate def={def} />
    return <SliderCombo def={def} /> // scalar decibel
  }
  if (kind === 'toggle') return <Toggle def={def} />
  if (kind === 'degrees') return <SliderCombo def={def} />
  if (kind === 'frequency_hz') return <ValueBox def={def} />
  if (kind === 'integer') {
    // Small range → slider; wide (band counts, 20 kHz) → value box.
    return def.max - def.min <= 32 ? (
      <SliderCombo def={def} />
    ) : (
      <ValueBox def={def} />
    )
  }
  console.warn(`advanced: no widget for ${def.name} (${kind})`)
  return <Readout def={def} />
}

export default WidgetFactory
