import { Show, createMemo, type Component } from 'solid-js'
import { encode } from 'uqr'
import { state } from '../store/state'
import { setLanAccess } from '../store/ws'
import './LanToggle.css'

/** One `1×1` square per dark module — the QR as a single SVG path. */
function qrPath(data: boolean[][]): string {
  return data
    .flatMap((row, y) =>
      row.flatMap((dark, x) =>
        dark ? [`M${String(x)} ${String(y)}h1v1h-1z`] : [],
      ),
    )
    .join('')
}

/**
 * The URL + QR a phone scans to land on the UI (issue #71). Black on
 * white whatever the skin — scan contrast is function, not style; the
 * baked-in border is the QR quiet zone, kept white for the same reason.
 */
const LanDiscovery: Component<{ url: string }> = (props) => {
  const qr = createMemo(() => encode(props.url, { border: 2 }))
  return (
    <figure class="lan-discovery">
      <svg
        class="lan-discovery__qr"
        role="img"
        aria-label="Scan to open DolbyX on your phone"
        viewBox={`0 0 ${String(qr().size)} ${String(qr().size)}`}
        shape-rendering="crispEdges"
      >
        <rect width={qr().size} height={qr().size} fill="#fff" />
        <path d={qrPath(qr().data)} fill="#000" />
      </svg>
      <figcaption class="lan-discovery__url">{props.url}</figcaption>
    </figure>
  )
}

/**
 * The LAN access row (ADR-0012): the toggle renders store truth, flips
 * local-first on ack like power — a refused flip never moves it, the
 * daemon's store never moved either. While on, the discovery URL + QR
 * sit beside it (issue #71), rendered from the snapshot `lan_url` this
 * tab already holds — originator suppression starves the flipping tab
 * of its own flip's snapshot, so held data is the only source. A
 * routeless host's `null` leaves the toggle standing alone.
 */
const LanToggle: Component = () => (
  <div class="lan-access">
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
    <Show when={state.lan_access && state.lan_url}>
      {(url) => <LanDiscovery url={url()} />}
    </Show>
  </div>
)

export default LanToggle
