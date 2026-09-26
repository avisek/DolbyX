// PROTOTYPE — throwaway, do not review
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
 * The three signature DDP controls — a curated overlay pairing an
 * enable param with an amount param (CONTEXT.md "Master control"), in
 * the original's order. Each half resolves kind, range, `frac_bits`
 * from the bootstrap table; the same params sit in the Advanced panel
 * on the same shared controls. Profile path only.
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

/** Distinct from the panel's `adv-<4-CC>`, which renders the same params. */
const controlId = (def: ParameterDef): string => `master-${def.name}`

/**
 * One master control: a `label` for its SWITCH — clicking the title
 * toggles it — with the Reset marker (#92), the switch, and the amount
 * region: numeric box + Slider (one line the skin may drop under the
 * title when narrow). The box, Slider, and marker keep their own click
 * (the native guard). Skin reads `master-control--diverged`.
 */
const MasterControl: Component<{
  label: string
  enable: ParameterDef
  amount: ParameterDef
}> = (props) => {
  // eslint-disable-next-line solid/reactivity
  const enable = props.enable
  // eslint-disable-next-line solid/reactivity
  const amount = props.amount
  const pair = [enable.name, amount.name]
  const profileId = () => state.selected_profile

  const diverged = () => {
    const profile = selectedProfile()
    return profile !== undefined && paramsDiverge(profile, pair)
  }

  const onToggle = (on: boolean) => {
    editProfile(profileId(), { [enable.name]: [on ? onValue(enable.kind) : 0] })
  }

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
      for={controlId(enable)}
      on:click={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            '.adv-input, .adv-slider, .master-control__reset',
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
      <Toggle
        id={controlId(enable)}
        name={`${props.label} enable`}
        checked={head(enable) !== 0}
        onToggle={onToggle}
      />
      <div class="master-control__control">
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
