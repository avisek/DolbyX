// PROTOTYPE — throwaway, do not review
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
 * baked-in border is the quiet zone. A focus target (`tabindex=-1`):
 * open moves focus here, and it stays open while it holds focus.
 */
const LanQr: Component<{
  url: string
  ref: (figure: HTMLElement) => void
  onKeyDown: (event: KeyboardEvent) => void
  onFocusOut: (event: FocusEvent) => void
}> = (props) => {
  const qr = createMemo(() => encode(props.url, { border: 2 }))
  return (
    <figure
      ref={props.ref}
      class="lan-access__qr"
      tabindex="-1"
      onKeyDown={(event) => {
        props.onKeyDown(event)
      }}
      onFocusOut={(event) => {
        props.onFocusOut(event)
      }}
    >
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
 * The LAN access row (ADR-0012): a `label` for the shared Toggle —
 * the whole row is the switch's hit area, like a panel card —
 * ack-then-apply. The discovery URL (a readonly field: focusable,
 * partially selectable) + copy + QR sit in the DOM whenever the
 * snapshot carries `lan_url` (issue #71); the skin reveals them by
 * `--on`. The QR figure is the tools' sibling, not their child: the
 * skin clips the tools to fold them, and a popover must escape. State as modifiers: `--on`, `--qr` (QR open), `--copied`
 * (1.5 s after a copy). The QR is a focus-scoped popover: open moves
 * focus to the figure; Escape / Enter or focus leaving it closes it.
 */
const LanToggle: Component = () => {
  const [qr, setQr] = createSignal(false)
  const [copied, setCopied] = createSignal(false)
  let figure: HTMLElement | undefined
  let qrButton!: HTMLButtonElement
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
  // Off folds the popover's anchor away: the popover goes with it.
  createEffect(
    on(
      () => state.lan_access,
      (on) => {
        if (!on) setQr(false)
      },
    ),
  )
  const copy = (url: string) => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => setCopied(false), COPIED_MS)
    })
  }
  const openQr = () => {
    setQr(true)
    figure?.focus()
  }
  const closeQr = (refocus: boolean) => {
    setQr(false)
    if (refocus) qrButton.focus()
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
      // Native, not delegated: the guard must have run by the time the
      // label's activation behavior asks whether the click was cancelled.
      on:click={(event) => {
        // The URL field and the buttons keep their own click / focus;
        // the row's own chrome forwards to the switch.
        if (
          event.target instanceof Element &&
          event.target.closest(
            '.lan-access__url, .lan-access__copy, .lan-access__qr-toggle, .lan-access__qr',
          )
        ) {
          event.preventDefault()
        }
      }}
    >
      <span class="lan-access__text">LAN Access</span>
      <span class="lan-access__cluster">
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
                  type="text"
                  class="lan-access__url"
                  aria-label="LAN URL"
                  readonly
                  value={url()}
                />
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
              <LanQr
                url={url()}
                ref={(element) => {
                  figure = element
                }}
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
                    (figure?.contains(next) === true || next === qrButton)
                  ) {
                    return
                  }
                  closeQr(false)
                }}
              />
            </>
          )}
        </Show>
      </span>
    </label>
  )
}

export default LanToggle
