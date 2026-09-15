// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One widget per (kind, access) combo, metadata-driven — no per-param
 * code, no layout policy (skins lay out the control region). Kind
 * decides structure: `version` is one read-only dotted text field;
 * EVERY other long array (`length > 1` — writable, read-only, opaque,
 * live vis, `aobg`) renders the one BandArray DOM; scalars pick a
 * native checkbox switch / native radio tristate / numeric box THEN
 * slider (always, whatever the range — skins may hide the slider;
 * FrequencyHz sliders are logarithmic) / read-only numeric box + a
 * disabled slider (same geometry as its writable twin). Discrete
 * commits = ack-then-apply (the native flip is cancelled; the store's
 * ack lands it); drags / scrubs / typing = optimistic live per step.
 */
import { For, type Component, type JSX } from 'solid-js'
import { onValue, unitLabel, type ParameterDef } from '../lib/parameters'
import { rawToDisplay } from '../lib/units'
import BandArray, {
  coarseStep,
  display,
  fineStep,
  firstBandId,
  toRaw,
} from './BandArray'
import NumberInput from './NumberInput'
import Slider from './Slider'
import { commitParam, isWritable, liveParam, paramValues } from './wiring'

/** Raw head value. */
const head = (def: ParameterDef): number => paramValues(def)[0] ?? 0

const isTristate = (def: ParameterDef): boolean =>
  typeof def.kind === 'object' && 'tristate' in def.kind

/** Slider scale by kind: frequencies live on a log axis. */
const scale = (def: ParameterDef): 'linear' | 'log' =>
  def.kind === 'frequency_hz' ? 'log' : 'linear'

// — Element ids: the card's `for` target —

const controlId = (def: ParameterDef): string => `adv-${def.name}`
const radioId = (def: ParameterDef, option: number): string =>
  `adv-${def.name}-r${String(option)}`

/** The primary control the card labels: the numeric / version field,
 * the checkbox, the CURRENTLY CHECKED radio, the first writable band
 * — none for a read-only array. Mirrors the dispatch below. */
export function primaryControlId(def: ParameterDef): string | undefined {
  if (def.kind === 'version') return controlId(def)
  if (def.length > 1) return isWritable(def) ? firstBandId(def) : undefined
  if (isWritable(def) && isTristate(def)) return radioId(def, head(def))
  return controlId(def)
}

// — Scalar widgets —

/** Native checkbox as a switch — the skin paints it via `:checked`. */
const Toggle: Component<{ def: ParameterDef; name: string }> = (props) => (
  <input
    type="checkbox"
    role="switch"
    id={controlId(props.def)}
    class="adv-toggle"
    aria-label={props.name}
    checked={head(props.def) !== 0}
    onClick={(event) => {
      // Ack-then-apply: cancel the native flip; the ack lands it.
      event.preventDefault()
      commitParam(props.def, [
        head(props.def) === 0 ? onValue(props.def.kind) : 0,
      ])
    }}
  />
)

/** 0 / 1 / 2 — DAP_FEATURE_OFF / ON / AUTO (`tristate.on` is what a
 * curated *toggle* writes for "on"; the panel exposes all three). */
const TRISTATE = ['Off', 'On', 'Auto'] as const

/** Native radio group; the skin paints a segmented control via
 * `:checked + label`. */
const Tristate: Component<{ def: ParameterDef; name: string }> = (props) => (
  <div class="adv-tristate" role="radiogroup" aria-label={props.name}>
    <For each={TRISTATE}>
      {(label, option) => (
        <>
          <input
            type="radio"
            id={radioId(props.def, option())}
            class="adv-tristate__radio"
            name={`adv-${props.def.name}`}
            value={String(option())}
            checked={head(props.def) === option()}
            onClick={(event) => {
              // Ack-then-apply, as the switch; re-picking the checked
              // option (the card label forwards there) writes nothing.
              event.preventDefault()
              if (head(props.def) !== option()) {
                commitParam(props.def, [option()])
              }
            }}
          />
          <label class="adv-tristate__seg" for={radioId(props.def, option())}>
            {label}
          </label>
        </>
      )}
    </For>
  </div>
)

/** Numeric box THEN slider — every writable Integer / Decibel /
 * Frequency / Degrees scalar, regardless of range. */
const Numeric: Component<{ def: ParameterDef; name: string }> = (props) => {
  const def = props.def
  const value = (): number => display(def, head(def))
  const onLive = (next: number): void => {
    liveParam(def, [toRaw(def, next)])
  }
  const onCommit = (next: number): void => {
    commitParam(def, [toRaw(def, next)])
  }
  return (
    <>
      <NumberInput
        id={controlId(def)}
        name={props.name}
        scrub
        value={value}
        min={rawToDisplay(def.min, def.frac_bits)}
        max={rawToDisplay(def.max, def.frac_bits)}
        coarse={coarseStep(def)}
        fine={fineStep(def)}
        unit={unitLabel(def.kind)}
        onLive={onLive}
        onCommit={onCommit}
      />
      <Slider
        name={props.name}
        value={value}
        min={rawToDisplay(def.min, def.frac_bits)}
        max={rawToDisplay(def.max, def.frac_bits)}
        fine={fineStep(def)}
        coarse={coarseStep(def)}
        unit={unitLabel(def.kind)}
        scale={scale(def)}
        onLive={onLive}
        onCommit={onCommit}
      />
    </>
  )
}

/** Read-only scalar — the same box, `readonly`, plus a disabled
 * slider: consistent geometry, keyboard select/copy. */
const Readout: Component<{ def: ParameterDef; name: string }> = (props) => {
  const def = props.def
  const value = (): number => display(def, head(def))
  return (
    <>
      <NumberInput
        id={controlId(def)}
        name={props.name}
        readOnly
        value={value}
        min={rawToDisplay(def.min, def.frac_bits)}
        max={rawToDisplay(def.max, def.frac_bits)}
        unit={unitLabel(def.kind)}
      />
      <Slider
        name={props.name}
        value={value}
        min={rawToDisplay(def.min, def.frac_bits)}
        max={rawToDisplay(def.max, def.frac_bits)}
        fine={fineStep(def)}
        coarse={coarseStep(def)}
        unit={unitLabel(def.kind)}
        scale={scale(def)}
        disabled
      />
    </>
  )
}

/** `version` — the tuple as one read-only dotted text field (`ver`:
 * `2.0.4.0`), the numeric box's DOM shape under a `--text` modifier. */
const Version: Component<{ def: ParameterDef; name: string }> = (props) => (
  <span class="adv-input adv-input--text">
    <input
      id={controlId(props.def)}
      class="adv-input__field"
      type="text"
      readonly
      aria-label={props.name}
      value={paramValues(props.def).join('.')}
    />
  </span>
)

// — Dispatch —

/** Dispatches a `(kind, access)` combo to its widget. `def` is static
 * per card, so plain setup-time branching stays sound. `name` is the
 * accessible name (category + short label). */
const WidgetFactory: Component<{ def: ParameterDef; name: string }> = (
  props,
): JSX.Element => {
  const def = props.def
  if (def.kind === 'version') return <Version def={def} name={props.name} />
  // Every other long array is the one band DOM (access only gates the
  // inputs inside).
  if (def.length > 1) return <BandArray def={def} name={props.name} />
  if (!isWritable(def)) return <Readout def={def} name={props.name} />
  if (def.kind === 'toggle') return <Toggle def={def} name={props.name} />
  if (isTristate(def)) return <Tristate def={def} name={props.name} />
  return <Numeric def={def} name={props.name} />
}

export default WidgetFactory
