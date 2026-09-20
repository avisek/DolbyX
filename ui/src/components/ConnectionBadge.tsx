import type { Component } from 'solid-js'
import { connected } from '../store/ws'

/** Live WS connection state — connected, or reconnecting with backoff. */
const ConnectionBadge: Component = () => (
  <span
    class="connection-badge"
    classList={{ 'connection-badge--connected': connected() }}
    role="status"
  >
    {connected() ? 'Connected' : 'Reconnecting…'}
  </span>
)

export default ConnectionBadge
