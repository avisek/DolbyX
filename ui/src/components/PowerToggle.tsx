import type { Component } from 'solid-js'
import { state } from '../store/state'
import { setPower } from '../store/ws'
import Toggle from './Toggle'

/**
 * The master power Row (#117): the shared `Toggle`, ack-then-apply
 * through `setPower`, behind a `label` the skin stretches over the whole
 * header (its `::before`) — so the header, wordmark included, is the
 * switch's hit area (ADR-0011, second addendum).
 */
const PowerToggle: Component = () => (
  <label class="power" for="power">
    <span class="power__text">Power</span>
    <Toggle id="power" name="Power" checked={state.power} onToggle={setPower} />
  </label>
)

export default PowerToggle
