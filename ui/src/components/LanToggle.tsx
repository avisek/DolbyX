import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type Component,
} from 'solid-js'
import { encode } from 'uqr'
import { cardRule } from '../lib/card_rule'
import { state } from '../store/state'
import { setLanAccess } from '../store/ws'
import Toggle from './Toggle'

/** How long Copy confirms — the `--copied` modifier's life. */
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
 * baked-in border is the quiet zone.
 */
const LanQr: Component<{ url: string }> = (props) => {
  const qr = createMemo(() => encode(props.url, { border: 2 }))
  return (
    <svg
      role="img"
      aria-label="Scan to open DolbyX on your phone"
      viewBox={`0 0 ${String(qr().size)} ${String(qr().size)}`}
      shape-rendering="crispEdges"
    >
      <rect width={qr().size} height={qr().size} fill="#fff" />
      <path d={qrPath(qr().data)} fill="#000" />
    </svg>
  )
}

/**
 * The LAN Access Row (#118, ADR-0012): a `label` for the shared Toggle
 * — the whole row is the switch's hit area — ack-then-apply through
 * `setLanAccess`. The discovery tools (a readonly URL field: focusable,
 * partially selectable; Copy; the QR button) sit in the DOM whenever
 * the snapshot carries `lan_url` — it does while off too — and the
 * skin folds them by `--on`. The QR figure is the tools' sibling, not
 * their child: the skin clips the tools to fold them, and a popover
 * must escape. State as modifiers: `--on`, `--qr` (the QR Popover is
 * open), `--copied` (1.5 s after a copy — timed state stays
 * component-side, ADR-0011 addendum 2). Copy uses the async clipboard
 * where the context is secure, the legacy copy command elsewhere. The
 * Popover owns its focus (CONTEXT.md): opening focuses the figure;
 * Escape / Enter or focus leaving it closes it; LAN going off closes
 * it too.
 */
const LanToggle: Component = () => {
  const [qr, setQr] = createSignal(false)
  let figure!: HTMLElement
  let qrButton!: HTMLButtonElement
  // Off folds the popover's anchor away: the popover goes with it.
  createEffect(
    on(
      () => state.lan_access,
      (lanOn) => {
        if (!lanOn) setQr(false)
      },
      { defer: true },
    ),
  )
  const openQr = () => {
    setQr(true)
    figure.focus()
  }
  const closeQr = (refocus: boolean) => {
    setQr(false)
    if (refocus) qrButton.focus()
  }

  const [copied, setCopied] = createSignal(false)
  let urlField!: HTMLInputElement
  let copyButton!: HTMLButtonElement
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  let mounted = true
  onCleanup(() => {
    mounted = false
    clearTimeout(copiedTimer)
  })
  const confirmCopy = () => {
    // The async write may resolve after the Row is gone: no timer then.
    if (!mounted) return
    setCopied(true)
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => setCopied(false), COPIED_MS)
  }
  const copy = (url: string) => {
    // `navigator.clipboard` exists only in a secure context — localhost
    // on the host, never a LAN client over plain http (ADR-0012). There
    // the legacy command copies the selection, synchronously inside the
    // click gesture: select the URL field, copy, hand focus back.
    // The lib types promise `clipboard` unconditionally; the platform
    // does not.
    const clipboard = (navigator as { clipboard?: Clipboard }).clipboard
    if (clipboard) {
      void clipboard.writeText(url).then(confirmCopy)
      return
    }
    urlField.select()
    // Deprecated, never removed: the only copy path an insecure context
    // has, and every browser keeps it for exactly that reason.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand('copy')
    urlField.setSelectionRange(0, 0)
    copyButton.focus()
    if (ok) confirmCopy()
  }
  return (
    <label
      class="lan-access"
      classList={{
        'lan-access--on': state.lan_access,
        'lan-access--qr': qr(),
        'lan-access--copied': copied(),
      }}
      for="lan"
      // The URL field, the buttons and the popover keep their own click
      // and focus; the text and empty space forward to the switch.
      on:click={cardRule(
        '.lan-access__url, .lan-access__copy, .lan-access__qr-toggle, .lan-access__qr',
      )}
    >
      <span class="lan-access__text">LAN Access</span>
      <Toggle
        id="lan"
        name="LAN access"
        checked={state.lan_access}
        onToggle={setLanAccess}
      />
      <Show when={state.lan_url}>
        {(url) => (
          <>
            <span class="lan-access__tools">
              <input
                ref={urlField}
                type="text"
                class="lan-access__url"
                aria-label="LAN URL"
                readonly
                value={url()}
              />
              <button
                ref={copyButton}
                type="button"
                class="lan-access__copy"
                aria-label="Copy URL"
                title="Copy URL"
                onClick={() => {
                  copy(url())
                }}
              />
              <button
                ref={qrButton}
                type="button"
                class="lan-access__qr-toggle"
                aria-pressed={qr()}
                aria-label="Show QR code"
                title="Show QR code"
                onClick={() => {
                  if (qr()) closeQr(false)
                  else openQr()
                }}
              />
            </span>
            {/* The Popover's focus target (`tabindex=-1`): opening
                moves focus here, and it stays open while it holds it. */}
            <figure
              ref={figure}
              class="lan-access__qr"
              tabindex="-1"
              onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Enter') {
                  event.preventDefault()
                  closeQr(true)
                }
              }}
              onFocusOut={(event) => {
                const next = event.relatedTarget
                // Focus moving within the popover, or onto its own
                // button (whose click then toggles), keeps it open.
                if (
                  next instanceof Node &&
                  (figure.contains(next) || next === qrButton)
                ) {
                  return
                }
                closeQr(false)
              }}
            >
              <LanQr url={url()} />
            </figure>
          </>
        )}
      </Show>
    </label>
  )
}

export default LanToggle
