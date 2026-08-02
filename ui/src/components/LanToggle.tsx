import type { Component } from 'solid-js'
import { state } from '../store/state'
import { setLanAccess } from '../store/ws'
import './LanToggle.css'

/**
 * The LAN access toggle (ADR-0012): renders store truth, flips
 * local-first on ack like power. A refused flip never moves it — the
 * daemon's store never moved either.
 */
const LanToggle: Component = () => (
  <button
    type="button"
    class="lan-toggle"
    role="switch"
    aria-checked={state.lan_access}
    onClick={() => {
      setLanAccess(!state.lan_access)
    }}
  >
    <span class="lan-toggle__track" aria-hidden="true">
      <span class="lan-toggle__thumb" />
    </span>
    LAN access
  </button>
)

export default LanToggle
