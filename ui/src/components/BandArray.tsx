import {
  For,
  Index,
  Show,
  createEffect,
  createSignal,
  type Component,
} from 'solid-js'
import { ENGAGE_PX } from '../lib/gesture'
import { unitLabel, type ParameterDef } from '../lib/parameters'
import { axisOf, displayValue, rawValue } from '../lib/scalar'
import { stepped, type Modifiers } from '../lib/step'
import {
  channelRows,
  commitParam,
  effectiveCount,
  isLive,
  isWritable,
  liveParam,
  paramValues,
  type ChannelRow,
} from '../store/wiring'
import NumberInput from './NumberInput'

/** One band's editor id; `aobg` rows key theirs by channel index. */
export function bandInputId(
  def: ParameterDef,
  slot: number,
  chan?: number,
): string {
  const row = chan === undefined ? '' : `-c${String(chan)}`
  return `adv-${def.name}${row}-b${String(slot)}`
}

/** The first band editor's id — the card's `for` target (dangling
 * while `aobg` has no channel rows; harmless). */
export function firstBandId(def: ParameterDef): string {
  return isChannelMajor(def) ? bandInputId(def, 0, 0) : bandInputId(def, 0)
}

const isChannelMajor = (def: ParameterDef): boolean =>
  def.kind === 'aobg_channel_major'

/** 0–1 of the def's raw range — the bar's height, always linear
 * (a log axis is a stepping / Slider concern, never a bar's). */
const norm = (def: ParameterDef, raw: number): number =>
  (raw - def.min) / (def.max - def.min || 1)

const slots = (count: number): readonly number[] =>
  Array.from({ length: count }, (_slot, slot) => slot)

/** One band of one strip: its row and its slot. */
interface BandAt {
  readonly row: number
  readonly slot: number
}

/** `text` with the def's unit appended, `sep` between — nothing when
 * the kind is unit-less. */
const withUnit = (def: ParameterDef, text: string, sep = ' '): string => {
  const unit = unitLabel(def.kind)
  return unit === '' ? text : `${text}${sep}${unit}`
}

/** The meta line's `band N · value unit` for one band. */
const bandText = (def: ParameterDef, slot: number, raw: number): string =>
  `band ${String(slot + 1)} · ${withUnit(def, String(displayValue(def, raw)))}`

/** A digit, `.` or `-` typed plain — never a browser shortcut
 * (Ctrl+`-` zooms). */
const isTyped = (event: KeyboardEvent): boolean =>
  /^[\d.-]$/.test(event.key) && !event.ctrlKey && !event.metaKey

/** Writes one strip's array: the whole stored array with one slot
 * changed, live (mid-gesture) or committed. Absent on a strip whose
 * access takes no writes. */
type StripWrite = (slot: number, raw: number, live: boolean) => void

/**
 * One strip — `role=group`, one Tab stop — of `count` bands over a raw
 * source: each a bar publishing `--value` (display units) and `--norm`
 * (linear over `[min, max]`) plus an editor — the numeric box,
 * `tabindex=-1`; `readonly` unless `write` is given.
 *
 * Roving keyboard model (#91): ← / → / Home / End move the active band
 * (`--active`, clamped into the count as it shrinks); ↑ / ↓ step it by
 * the Step rule and write the array live. Handled keys are consumed —
 * the page never scrolls, nothing above re-handles.
 *
 * Marks the hovered band (`--hover`) and reports it to its container.
 */
const Strip: Component<{
  def: ParameterDef
  name: string
  row: number
  count: () => number
  raw: (slot: number) => number
  idFor: (slot: number) => string
  write?: StripWrite | undefined
  hover: () => BandAt | undefined
  onHover: (at: BandAt | undefined) => void
  /** The band the keyboard is on — editing, else active while the
   * strip itself is focused; `undefined` when focus is elsewhere. */
  onFocusBand: (at: BandAt | undefined) => void
}> = (props) => {
  // Static per strip, like the factory's `def`.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  // eslint-disable-next-line solid/reactivity
  const write = props.write
  const axis = axisOf(def)
  const value = (slot: number): number => displayValue(def, props.raw(slot))
  const hovered = (slot: number): boolean => {
    const at = props.hover()
    return at?.row === props.row && at.slot === slot
  }
  let strip!: HTMLDivElement

  // — Roving state —
  const [activeSlot, setActive] = createSignal(0)
  /** The band whose editor holds focus — derived from focus-within,
   * never a flag of the strip's own. */
  const [editingSlot, setEditing] = createSignal<number>()
  /** Whether the strip element itself holds focus. */
  const [focused, setFocused] = createSignal(false)
  const lastSlot = (): number => Math.max(0, props.count() - 1)
  // Both clamp into the effective count as it shrinks: the active band
  // moves in; an editor removed under focus (no `focusout` fires) is no
  // longer editing.
  const active = (): number => Math.min(activeSlot(), lastSlot())
  const editing = (): number | undefined => {
    const slot = editingSlot()
    return slot !== undefined && slot <= lastSlot() ? slot : undefined
  }
  createEffect(() => {
    const slot = editing() ?? (focused() ? active() : undefined)
    props.onFocusBand(slot === undefined ? undefined : { row: props.row, slot })
  })

  /** A band's editor input, by position among the bands. */
  const inputAt = (slot: number): HTMLInputElement | null =>
    strip.children[slot]?.querySelector('input') ?? null

  /** Opens a band's editor: its input focused, text selected. */
  const openEditor = (slot: number): void => {
    setActive(slot)
    const input = inputAt(slot)
    input?.focus()
    input?.select()
  }

  /** Type-to-edit: the keystroke becomes the editor's whole text, and
   * the box commits it by its own rules (instant clamp-commit). */
  const typeInto = (slot: number, key: string): void => {
    openEditor(slot)
    const input = inputAt(slot)
    if (!input) return
    input.value = key
    input.setSelectionRange(1, 1)
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }

  const inEditor = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('.adv-bands__editor') !== null

  /** Steps the active band by the Step rule; a step the range absorbs
   * writes nothing. */
  const nudge = (direction: 1 | -1, mods: Modifiers): void => {
    const slot = active()
    const next = rawValue(def, stepped(axis, value(slot), direction, mods))
    if (next !== props.raw(slot)) write?.(slot, next, true)
  }

  // — Pointer, click half: press arms, release without travel opens
  // the pressed band's editor (reveal on click, never on press);
  // travel past ENGAGE_PX disarms. A gesture starting on an editor is
  // the box's own (its Scrub, #88) — the strip ignores it.
  /** The armed pointer, its origin and its band; `undefined` at rest. */
  let armed: { id: number; x: number; y: number; slot: number } | undefined

  const disarm = (event: PointerEvent): void => {
    if (armed?.id !== event.pointerId) return
    armed = undefined
    if (strip.hasPointerCapture(event.pointerId)) {
      strip.releasePointerCapture(event.pointerId)
    }
  }

  /** The band under an event target, by position among the bands. */
  const bandAt = (target: EventTarget | null): BandAt | undefined => {
    const band =
      target instanceof Element ? target.closest('.adv-bands__band') : null
    const slot = band ? Array.prototype.indexOf.call(strip.children, band) : -1
    return slot >= 0 ? { row: props.row, slot } : undefined
  }

  return (
    <div
      ref={strip}
      class="adv-bands__strip"
      role="group"
      tabindex="0"
      aria-label={props.name}
      style={{ '--count': String(props.count()) }}
      onFocusIn={(event) => {
        if (event.target === strip) {
          setFocused(true)
          return
        }
        const slot = inEditor(event.target)
          ? bandAt(event.target)?.slot
          : undefined
        if (slot === undefined) return
        setEditing(slot)
        setActive(slot)
      }}
      onFocusOut={(event) => {
        if (event.target === strip) setFocused(false)
        else if (inEditor(event.target)) setEditing(undefined)
      }}
      onKeyDown={(event) => {
        const key = event.key
        if (event.target !== strip) {
          // Inside an editor: the box committed (Enter) or reverted
          // (Esc) and blurred — bring focus home.
          if ((key === 'Enter' || key === 'Escape') && inEditor(event.target)) {
            strip.focus()
            event.preventDefault()
            event.stopPropagation()
          }
          return
        }
        if (key === 'ArrowLeft') setActive(Math.max(0, active() - 1))
        else if (key === 'ArrowRight')
          setActive(Math.min(lastSlot(), active() + 1))
        else if (key === 'Home') setActive(0)
        else if (key === 'End') setActive(lastSlot())
        else if (key === 'Enter') openEditor(active())
        else if (write && key === 'ArrowUp') nudge(1, event)
        else if (write && key === 'ArrowDown') nudge(-1, event)
        else if (write && isTyped(event)) typeInto(active(), key)
        else return
        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || armed || inEditor(event.target)) return
        const at = bandAt(event.target)
        if (!at) return
        armed = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          slot: at.slot,
        }
        strip.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!armed) {
          props.onHover(bandAt(event.target))
          return
        }
        if (event.pointerId !== armed.id) return
        const travel = Math.hypot(
          event.clientX - armed.x,
          event.clientY - armed.y,
        )
        if (travel >= ENGAGE_PX) disarm(event)
      }}
      onPointerUp={(event) => {
        const slot = armed?.id === event.pointerId ? armed.slot : undefined
        disarm(event)
        if (slot !== undefined) openEditor(slot)
      }}
      onPointerCancel={disarm}
      onPointerLeave={() => {
        props.onHover(undefined)
      }}
    >
      <For each={slots(props.count())}>
        {(slot) => (
          <span
            class="adv-bands__band"
            classList={{
              'adv-bands__band--active': active() === slot,
              'adv-bands__band--editing': editing() === slot,
              'adv-bands__band--hover': hovered(slot),
            }}
            title={withUnit(
              def,
              `${def.name}[${String(slot + 1)}] = ${String(value(slot))}`,
            )}
          >
            <span
              class="adv-bands__bar"
              aria-hidden="true"
              style={{
                '--value': String(value(slot)),
                '--norm': String(norm(def, props.raw(slot))),
              }}
            />
            <span class="adv-bands__editor">
              <NumberInput
                id={props.idFor(slot)}
                name={`${props.name} band ${String(slot + 1)}`}
                value={() => value(slot)}
                axis={axis}
                unit=""
                readOnly={!write}
                tabIndex={-1}
                onLive={(next) => {
                  write?.(slot, rawValue(def, next), true)
                }}
                onCommit={(next) => {
                  // Store truth is raw: a typed value on the same
                  // lattice step has nothing to commit.
                  const raw = rawValue(def, next)
                  if (raw !== props.raw(slot)) write?.(slot, raw, false)
                }}
              />
            </span>
          </span>
        )}
      </For>
    </div>
  )
}

/** A source shorter than the count (a snapshot carrying fewer slots
 * than the allocation) reads the table default for the tail. */
const rawAt = (def: ParameterDef, slot: number): number =>
  paramValues(def)[slot] ?? def.default[slot] ?? def.min

/** The stored array with `index` set to `raw` — the array a band
 * write sends whole; a tail slot the store never carried is filled
 * from the table default up to it. */
function withRaw(def: ParameterDef, index: number, raw: number): number[] {
  const values = paramValues(def)
  const next = Array.from(
    { length: Math.max(values.length, index + 1) },
    (_raw, slot) => values[slot] ?? def.default[slot] ?? def.min,
  )
  next[index] = raw
  return next
}

/** A writable def's strip write at `offset` into the stored array —
 * live through the Source rule's optimistic path, else the commit.
 * Opaque blobs are cells, never edited, whatever their bucket. */
function stripWrite(
  def: ParameterDef,
  offset: () => number,
): StripWrite | undefined {
  if (!isWritable(def) || def.kind === 'opaque') return undefined
  return (slot, raw, live) => {
    ;(live ? liveParam : commitParam)(def, withRaw(def, offset() + slot, raw))
  }
}

/** The plain meta: the described band, else `count of length bands` —
 * an `opaque` kind counts `values`. */
function plainMeta(def: ParameterDef, at: BandAt | undefined): string {
  if (at) return bandText(def, at.slot, rawAt(def, at.slot))
  return withUnit(
    def,
    def.kind === 'opaque'
      ? `${String(def.length)} values`
      : `${String(effectiveCount(def))} of ${String(def.length)} bands`,
    ' · ',
  )
}

const gainAt = (def: ParameterDef, row: ChannelRow, slot: number): number =>
  row.gains[slot] ?? def.min

/** The `aobg` meta: the described band under its channel, else
 * `channels × bands`; no rows is the empty state. */
function channelMeta(def: ParameterDef, at: BandAt | undefined): string {
  const rows = channelRows(def)
  const row = at && rows[at.row]
  if (at && row) {
    return `ch ${String(row.id)} · ${bandText(def, at.slot, gainAt(def, row, at.slot))}`
  }
  const bands = rows[0]?.gains.length
  if (bands === undefined) return 'no channels configured'
  return withUnit(
    def,
    `${String(rows.length)} channels × ${String(bands)} bands`,
    ' · ',
  )
}

/**
 * The Band strip (#90, #91), a shared control — the one DOM every
 * `length > 1` param renders; kind decides structure, access gates
 * editability. Rows of `role=group` strips — one of `effectiveCount`
 * bands over the Source rule's values, or one per packed `aobg`
 * channel set (`channelRows`) labelled `ch <id>` from the data — each
 * band a bar publishing `--value` / `--norm` plus a `tabindex=-1`
 * editor. Writable strips (Settable / Experimental) take the roving
 * keyboard model and write the whole stored array through the Source
 * rule — an `aobg` row at its packed offset, the id slot untouched;
 * read-only, Live and opaque strips keep hover only. Hover marks a
 * band and describes it on the meta line; leaving restores the
 * summary. Modifiers from access — `--ro` for either read-only bucket,
 * `--live` for the Live arrays (the last `vis` frame held, no idle
 * state), `--opaque` for the blobs the skin draws as cells. No layout
 * policy — the skin lays the bands out (ADR-0011).
 */
const BandArray: Component<{ def: ParameterDef; name: string }> = (props) => {
  // Static per card, like the factory's `def`.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  const channelMajor = isChannelMajor(def)
  const [hover, setHover] = createSignal<BandAt>()
  const [focusBand, setFocusBand] = createSignal<BandAt>()
  // The described band: hovered, else the keyboard's (editing, else
  // active while its strip is focused), else the summary.
  const described = (): BandAt | undefined => hover() ?? focusBand()
  const meta = (): string =>
    channelMajor ? channelMeta(def, described()) : plainMeta(def, described())
  return (
    <div
      class="adv-bands"
      classList={{
        'adv-bands--ro': !isWritable(def),
        'adv-bands--live': isLive(def),
        'adv-bands--opaque': def.kind === 'opaque',
      }}
    >
      <Show
        when={channelMajor}
        fallback={
          <div class="adv-bands__row">
            <Strip
              def={def}
              name={props.name}
              row={0}
              count={() => effectiveCount(def)}
              raw={(slot) => rawAt(def, slot)}
              idFor={(slot) => bandInputId(def, slot)}
              write={stripWrite(def, () => 0)}
              hover={hover}
              onHover={setHover}
              onFocusBand={setFocusBand}
            />
          </div>
        }
      >
        <Index each={channelRows(def)}>
          {(row, chan) => (
            <div class="adv-bands__row">
              <span
                class="adv-bands__chan"
                title={`engine channel id ${String(row().id)}`}
              >
                ch {String(row().id)}
              </span>
              <Strip
                def={def}
                name={`${props.name} channel ${String(row().id)}`}
                row={chan}
                count={() => row().gains.length}
                raw={(slot) => gainAt(def, row(), slot)}
                idFor={(slot) => bandInputId(def, slot, chan)}
                write={stripWrite(def, () => row().offset)}
                hover={hover}
                onHover={setHover}
                onFocusBand={setFocusBand}
              />
            </div>
          )}
        </Index>
      </Show>
      <div class="adv-bands__meta" aria-live="polite">
        {meta()}
      </div>
    </div>
  )
}

export default BandArray
