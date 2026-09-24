// PROTOTYPE — throwaway, do not review
import type { Component } from 'solid-js'
import { state } from '../store/state'
import { setPower } from '../store/ws'
import Toggle from './Toggle'

/** The master power switch — the shared Toggle, ack-then-apply. */
const PowerToggle: Component = () => (
  <label class="power" for="power">
    <Toggle id="power" name="Power" checked={state.power} onToggle={setPower} />
    <span class="power__text">Power</span>
  </label>
)

export default PowerToggle
