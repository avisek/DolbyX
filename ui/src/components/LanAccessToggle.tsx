import type { Component } from 'solid-js'
import { state } from '../store/state'
import { setLanAccess } from '../store/ws'
import './LanAccessToggle.css'

/**
 * The LAN access toggle (ADR-0012): renders store truth, flips
 * local-first on ack. Off severs remote tabs — a remote tab flipping
 * it severs itself right after the ack (last snapshot keeps
 * rendering, commands stop). The QR beside it lands with discovery
 * (LAN access 3/4, #71).
 */
const LanAccessToggle: Component = () => (
  <button
    type="button"
    class="lan-access-toggle"
    role="switch"
    aria-checked={state.lan_access}
    onClick={() => {
      setLanAccess(!state.lan_access)
    }}
  >
    <span class="lan-access-toggle__track" aria-hidden="true">
      <span class="lan-access-toggle__thumb" />
    </span>
    LAN access
  </button>
)

export default LanAccessToggle
