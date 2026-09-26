// PROTOTYPE — throwaway, do not review
import type { Component } from 'solid-js'
import { state } from '../store/state'
import { setPower } from '../store/ws'
import Toggle from './Toggle'

/**
 * The master power switch — the shared Toggle, ack-then-apply, behind
 * a `label` the skin may stretch over the whole header (its `::before`)
 * so the header row is the switch's hit area.
 */
const PowerToggle: Component = () => (
  <label class="power" for="power">
    <span class="power__text">Power</span>
    <Toggle id="power" name="Power" checked={state.power} onToggle={setPower} />
  </label>
)

export default PowerToggle
