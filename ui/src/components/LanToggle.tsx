// PROTOTYPE — throwaway, do not review
import {
  Show,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from 'solid-js'
import { encode } from 'uqr'
import { state } from '../store/state'
import { setLanAccess } from '../store/ws'
import Toggle from './Toggle'

/** Css ms the copied state shows for. */
const COPIED_MS = 1500

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
 * The QR a phone scans to land on the UI (issue #71). Black on white
 * whatever the skin — scan contrast is function, not style; the
 * baked-in border is the quiet zone. Always in the DOM while LAN is
 * on; the skin shows it via `lan-access--qr`.
 */
const LanQr: Component<{ url: string }> = (props) => {
  const qr = createMemo(() => encode(props.url, { border: 2 }))
  return (
    <figure class="lan-access__qr">
      <svg
        class="lan-access__qr-svg"
        role="img"
        aria-label="Scan to open DolbyX on your phone"
        viewBox={`0 0 ${String(qr().size)} ${String(qr().size)}`}
        shape-rendering="crispEdges"
      >
        <rect width={qr().size} height={qr().size} fill="#fff" />
        <path d={qrPath(qr().data)} fill="#000" />
      </svg>
    </figure>
  )
}

/**
 * The LAN access row (ADR-0012): the shared Toggle, ack-then-apply.
 * While on, the discovery URL + copy + QR sit beside it (issue #71),
 * from the snapshot `lan_url` this tab holds. State as modifiers:
 * `--on`, `--qr` (QR revealed), `--copied` (1.5 s after a copy).
 */
const LanToggle: Component = () => {
  const [qr, setQr] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
  const copy = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }
  return (
    <div
      class="lan-access"
      classList={{
        'lan-access--on': state.lan_access,
        'lan-access--qr': qr(),
        'lan-access--copied': copied(),
      }}
    >
      <label class="lan-access__switch" for="lan">
        <Toggle
          id="lan"
          name="LAN access"
          checked={state.lan_access}
          onToggle={setLanAccess}
        />
        <span class="lan-access__text">LAN access</span>
      </label>
      <Show when={state.lan_access && state.lan_url}>
        {(url) => (
          <>
            <code class="lan-access__url">{url()}</code>
            <button
              type="button"
              class="lan-access__copy"
              aria-label="Copy URL"
              title="Copy URL"
              onClick={() => {
                copy(url())
              }}
            />
            <button
              type="button"
              class="lan-access__qr-toggle"
              aria-pressed={qr()}
              aria-label="Show QR code"
              title="Show QR code"
              onClick={() => setQr((on) => !on)}
            />
            <LanQr url={url()} />
          </>
        )}
      </Show>
    </div>
  )
}

export default LanToggle
