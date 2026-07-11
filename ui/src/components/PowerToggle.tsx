import type { Component } from 'solid-js'
import { state } from '../store/state'
import { setPower } from '../store/ws'
import './PowerToggle.css'

/** The master power toggle: renders store truth, flips local-first on ack. */
const PowerToggle: Component = () => (
  <button
    type="button"
    class="power-toggle"
    role="switch"
    aria-checked={state.power}
    onClick={() => {
      setPower(!state.power)
    }}
  >
    <span class="power-toggle__track" aria-hidden="true">
      <span class="power-toggle__thumb" />
    </span>
    Power
  </button>
)

export default PowerToggle
