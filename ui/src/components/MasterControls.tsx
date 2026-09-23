import { For, type Component } from 'solid-js'
import {
  onValue,
  paramDef,
  unitLabel,
  type ParameterDef,
} from '../lib/parameters'
import { axisOf, displayValue, rawValue } from '../lib/scalar'
import { paramsDiverge, selectedProfile, state } from '../store/state'
import { editProfile, editProfileLive, resetProfile } from '../store/ws'
import NumberInput from './NumberInput'
import Slider from './Slider'
import Toggle from './Toggle'

/**
 * The three signature DDP controls — a curated UI overlay pairing an
 * enable param with an amount param (CONTEXT.md "Master control"), in
 * the original's order (ADR-0004: never metadata-driven). Nothing
 * beyond the 4-CCs is hardcoded: each half resolves its kind, range,
 * and `frac_bits` from the bootstrap table. The same params also sit
 * in the Advanced panel under their categories, on the same shared
 * controls (#93): the switch, the numeric box + Slider, the Reset
 * marker. Profile path only — none of the six is preset-carried.
 */
const MASTER_CONTROLS = [
  { label: 'Surround Virtualizer', enable: 'vdhe', amount: 'dhsb' },
  { label: 'Dialog Enhancer', enable: 'deon', amount: 'dea' },
  { label: 'Volume Leveller', enable: 'dvle', amount: 'dvla' },
] as const

/** The active profile's raw head value for `def`. */
function head(def: ParameterDef): number {
  return selectedProfile()?.params[def.name]?.[0] ?? def.default[0] ?? 0
}

/** The element id of a master control's control — distinct from the
 * Advanced panel's `adv-<4-CC>`, which renders the same params. */
const controlId = (def: ParameterDef): string => `master-${def.name}`

/**
 * One master control: a `label` for its numeric box — the row's text is
 * the box's hit area; a click inside a control keeps the focus it set —
 * with the Reset marker (#92) before the control region, and the
 * region itself: switch, box, Slider. Zero appearance policy: the skin
 * reads `master-control--diverged` (ADR-0011).
 */
const MasterControl: Component<{
  label: string
  enable: ParameterDef
  amount: ParameterDef
}> = (props) => {
  // Static per row: the descriptor never changes within a page load.
  /* eslint-disable solid/reactivity */
  const enable = props.enable
  const amount = props.amount
  /* eslint-enable solid/reactivity */
  const pair = [enable.name, amount.name]
  const profileId = () => state.selected_profile

  /** Whether the active profile diverges on either half — the marker's
   * enabled state; client-derived from the snapshot's Baseline. */
  const diverged = () => {
    const profile = selectedProfile()
    return profile !== undefined && paramsDiverge(profile, pair)
  }

  // The switch: "on" writes the kind's on-value (`vdhe` is a tristate
  // whose `on` is 2 — never 1), "off" writes 0; ack-then-apply.
  const onToggle = (on: boolean) => {
    editProfile(profileId(), { [enable.name]: [on ? onValue(enable.kind) : 0] })
  }

  // The amount, display units in and out: every continuous gesture
  // writes live; blur / Enter / release commit only what differs.
  const value = () => displayValue(amount, head(amount))
  const axis = axisOf(amount)
  const unit = unitLabel(amount.kind)
  const onLive = (next: number) => {
    editProfileLive(profileId(), { [amount.name]: [rawValue(amount, next)] })
  }
  const onCommit = (next: number) => {
    const raw = rawValue(amount, next)
    if (raw !== head(amount)) editProfile(profileId(), { [amount.name]: [raw] })
  }

  const resetName = () => `Reset ${props.label}`
  return (
    <label
      class="master-control"
      classList={{ 'master-control--diverged': diverged() }}
      for={controlId(amount)}
      // A native listener (not Solid's delegated one): the guard must
      // have run by the time the label's activation behavior asks
      // whether the click was cancelled (the panel's card rule).
      on:click={(event) => {
        // Only the row's own chrome forwards to the box: the switch,
        // the box, and the marker keep their own click; the Slider
        // cancels its own (#89).
        if (
          event.target instanceof Element &&
          event.target.closest(
            '.adv-toggle, .adv-input, .master-control__reset',
          )
        ) {
          event.preventDefault()
        }
      }}
    >
      <span class="master-control__label">{props.label}</span>
      <button
        type="button"
        class="master-control__reset"
        disabled={!diverged()}
        aria-label={resetName()}
        title={resetName()}
        onClick={() => {
          resetProfile(profileId(), pair)
        }}
      />
      <div class="master-control__control">
        <Toggle
          id={controlId(enable)}
          name={`${props.label} enable`}
          checked={head(enable) !== 0}
          onToggle={onToggle}
        />
        <NumberInput
          id={controlId(amount)}
          name={`${props.label} amount`}
          value={value}
          axis={axis}
          unit={unit}
          scrub
          onLive={onLive}
          onCommit={onCommit}
        />
        <Slider
          name={`${props.label} amount`}
          value={value}
          axis={axis}
          unit={unit}
          onLive={onLive}
          onCommit={onCommit}
        />
      </div>
    </label>
  )
}

/** The main screen's three master controls (Slice 14, #22; #93). */
const MasterControls: Component = () => (
  <section class="master-controls" aria-label="Master controls">
    <For each={MASTER_CONTROLS}>
      {(control) => (
        <MasterControl
          label={control.label}
          enable={paramDef(control.enable)}
          amount={paramDef(control.amount)}
        />
      )}
    </For>
  </section>
)

export default MasterControls
