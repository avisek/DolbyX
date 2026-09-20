import { For, type Component } from 'solid-js'
import {
  onValue,
  paramDef,
  unitLabel,
  type ParameterDef,
} from '../lib/parameters'
import { displayToRaw, rawToDisplay } from '../lib/units'
import { selectedProfile, state } from '../store/state'
import { editProfile, editProfileLive } from '../store/ws'

/**
 * The three signature DDP controls — a curated UI overlay pairing an
 * enable param with an amount param (CONTEXT.md "Master control"), in
 * the original's order. Nothing beyond the 4-CCs is hardcoded: each
 * half resolves its kind, range, and `frac_bits` from the bootstrap
 * table. The same params also appear in the Advanced panel (Slice 20)
 * under their feature categories.
 */
const MASTER_CONTROLS = [
  { label: 'Surround Virtualizer', enable: 'vdhe', amount: 'dhsb' },
  { label: 'Dialog Enhancer', enable: 'deon', amount: 'dea' },
  { label: 'Volume Leveller', enable: 'dvle', amount: 'dvla' },
] as const

/** The active profile's raw value for `def` (scalar head slot). */
function rawValue(def: ParameterDef): number {
  return selectedProfile()?.params[def.name]?.[0] ?? def.default[0] ?? 0
}

/**
 * The bespoke enable switch of one master control: "on" writes the
 * kind's on-value (a tristate's declared `on` — `vdhe` writes 2), "off"
 * writes 0, each a 1-entry `edit_profile` applied local-first on ack.
 */
const EnableToggle: Component<{ label: string; def: ParameterDef }> = (
  props,
) => (
  <button
    type="button"
    class="master-control__toggle"
    role="switch"
    aria-checked={rawValue(props.def) !== 0}
    aria-label={`${props.label} enable`}
    onClick={() => {
      editProfile(state.selected_profile, {
        [props.def.name]: [
          rawValue(props.def) === 0 ? onValue(props.def.kind) : 0,
        ],
      })
    }}
  >
    <span class="master-control__track" aria-hidden="true">
      <span class="master-control__thumb" />
    </span>
  </button>
)

/**
 * The bespoke amount slider of one master control, working in display
 * units (`raw / 2^frac_bits`; the wire stays engine-native i16). Every
 * drag step is its own 1-entry `edit_profile` batch, applied
 * optimistically.
 */
const AmountSlider: Component<{ label: string; def: ParameterDef }> = (
  props,
) => {
  const display = () => rawToDisplay(rawValue(props.def), props.def.frac_bits)
  // ≤ 2 decimals, float noise trimmed — a readout, not the value.
  const readout = () => {
    const text = String(Number(display().toFixed(2)))
    const unit = unitLabel(props.def.kind)
    return unit === '' ? text : `${text} ${unit}`
  }
  return (
    <div class="master-control__amount">
      <input
        type="range"
        class="master-control__slider"
        aria-label={`${props.label} amount`}
        min={rawToDisplay(props.def.min, props.def.frac_bits)}
        max={rawToDisplay(props.def.max, props.def.frac_bits)}
        step={rawToDisplay(1, props.def.frac_bits)}
        value={display()}
        onInput={(event) => {
          editProfileLive(state.selected_profile, {
            [props.def.name]: [
              displayToRaw(
                event.currentTarget.valueAsNumber,
                props.def.frac_bits,
              ),
            ],
          })
        }}
      />
      <span class="master-control__value">{readout()}</span>
    </div>
  )
}

/** The main screen's three master controls (Slice 14, #22). */
const MasterControls: Component = () => (
  <section class="master-controls" aria-label="Master controls">
    <For each={MASTER_CONTROLS}>
      {(control) => (
        <div class="master-control">
          <div class="master-control__head">
            <span class="master-control__label">{control.label}</span>
            <EnableToggle
              label={control.label}
              def={paramDef(control.enable)}
            />
          </div>
          <AmountSlider label={control.label} def={paramDef(control.amount)} />
        </div>
      )}
    </For>
  </section>
)

export default MasterControls
