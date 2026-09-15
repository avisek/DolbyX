// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * THE unified long-array DOM every skin restyles: a container > rows
 * (one; `aobg`: one per channel, id-labelled) > a STRIP (the composite
 * widget — ONE Tab stop) > per-band elements, each the full strip
 * height (the hover / paint region) holding a BAR (publishes `--value`
 * in display units and `--norm`, 0–1 of the raw range) and an EDITOR
 * wrapper around the one numeric box (tabindex -1; writable: typed
 * edits commit live, scrubbable; read-only: `readonly`). Same shape
 * for band arrays, opaque readouts (`bver`, `bndl`, `lcmf`, `lcvd` —
 * `adv-bands--opaque`, skins draw cells), live vis arrays (fed from
 * the vis frame signal, NO idle state) and channel-major `aobg` rows.
 *
 * Keyboard, on the strip (roving): ← / → move the active band
 * (`adv-bands__band--active`); ↑ / ↓ nudge its value one coarse step,
 * Shift = one raw unit; Home / End first / last; Enter or a digit
 * opens the active band's editor — focuses its box, the digit lands
 * in it (`adv-bands__band--editing`, derived from focus); Esc / Enter
 * inside the box close it and return focus to the strip.
 *
 * Pointer, on bands outside the box: pointerdown + > 3 px engages the
 * brush — x over the bands → band, y within the band → value (max at
 * top, min at bottom), every band crossed since the last event
 * interpolated, ONE live write of the whole array per event, commit
 * on release; release without movement opens that band's editor
 * (reveal on click, not press). Gestures starting on the box never
 * paint (it keeps the numeric box's vertical scrub). Read-only strips:
 * hover, click reveal, no brush. The brush needs the bands laid out as
 * one row of equal columns (A / C); a wrapping cell grid (B) refuses
 * it.
 *
 * Meta line: `band N · value unit` for the hovered / editing / (strip
 * focused) active band, else the count summary.
 *
 * `aobg` layout — VERIFIED against the daemon's shipped defaults
 * (`defaults.toml`: `[2, 20 gains, 3, 20 gains]`) and docs/ddp/02:
 * channel sets are PACKED at stride `1 + aonb`, `aocc` of them
 * (runtime length `(aonb + 1) × aocc`); 329 is only the worst-case
 * allocation. Ids are engine channel ids (2 / 3 = the stereo pair).
 * No terminator scan — `AK_CHAN_EMPTY`'s value is undocumented and
 * the count params already bound the rows.
 */
import {
  For,
  Index,
  createEffect,
  createMemo,
  createSignal,
  type Accessor,
  type Component,
} from 'solid-js'
import { paramDef, unitLabel, type ParameterDef } from '../lib/parameters'
import { displayToRaw, rawToDisplay } from '../lib/units'
import type { VisParams } from '../lib/ws'
import { visFrame } from '../store/vis'
import NumberInput from './NumberInput'
import {
  commitParam,
  effectiveCount,
  isWritable,
  liveParam,
  paramValues,
} from './wiring'

// — Shared numeric helpers (WidgetFactory imports these too) —

/** Display value of one raw slot, float noise trimmed. */
export const display = (def: ParameterDef, raw: number): number =>
  Number(rawToDisplay(raw, def.frac_bits).toFixed(2))

/** Clamped display → raw commit value. */
export const toRaw = (def: ParameterDef, value: number): number =>
  Math.min(def.max, Math.max(def.min, displayToRaw(value, def.frac_bits)))

/** Scrub / nudge coarse step: 1 display unit, range-scaled so wide
 * ranges (20 kHz) stay traversable — ~256 steps across the span. */
export const coarseStep = (def: ParameterDef): number => {
  const span = rawToDisplay(def.max - def.min, def.frac_bits)
  return Math.max(1, Math.round(span / 256))
}

/** Scrub fine (Shift / arrow-key) step: one raw unit. */
export const fineStep = (def: ParameterDef): number =>
  rawToDisplay(1, def.frac_bits)

/** 0–1 of the def's raw range — the skin's bar-height variable. */
const norm = (def: ParameterDef, raw: number): number =>
  (raw - def.min) / (def.max - def.min || 1)

// — Element ids —

const bandId = (def: ParameterDef, slot: number, chan?: number): string =>
  chan === undefined
    ? `adv-${def.name}-b${String(slot)}`
    : `adv-${def.name}-c${String(chan)}-b${String(slot)}`

/** The first band input's id — the card's `for` target for writable
 * arrays (dangling for a channel-less `aobg`; harmless). */
export function firstBandId(def: ParameterDef): string {
  return def.kind === 'aobg_channel_major' ? bandId(def, 0, 0) : bandId(def, 0)
}

// — Seats —

/** One array surface: a band array, an `aobg` channel, a live vis
 * array. `write` absent = read-only (kind decides structure, access
 * gates editability). */
export interface ArraySeat {
  readonly def: ParameterDef
  readonly count: () => number
  readonly raws: () => readonly number[]
  /** Writes the whole visible array. `live` = mid-gesture; false =
   * commit. Absent = read-only. */
  readonly write?: (values: readonly number[], live: boolean) => void
}

/** Seat over a plain band array, `*nb`-trimmed, head-overlay writes. */
export function bandSeat(def: ParameterDef): ArraySeat {
  const count = (): number => effectiveCount(def)
  const raws = (): readonly number[] => paramValues(def).slice(0, count())
  if (!isWritable(def)) return { def, count, raws }
  return {
    def,
    count,
    raws,
    write: (values, live) => {
      ;(live ? liveParam : commitParam)(def, values)
    },
  }
}

/** Seat over a live vis array — the last frame's values, no idle
 * special case; snapshot/default before the first frame. */
function liveSeat(def: ParameterDef): ArraySeat {
  const key = def.name as keyof VisParams
  const count = (): number => effectiveCount(def)
  const raws = (): readonly number[] =>
    (visFrame()?.[key] ?? paramValues(def)).slice(0, count())
  return { def, count, raws }
}

/** One `aobg` channel set: `[id, gains…]` at `at - 1`. */
export interface ChanRow {
  readonly id: number
  readonly at: number
  readonly gains: readonly number[]
}

/** `aobg`-layout parse — packed channel sets, stride `1 + aonb`,
 * `aocc` rows (the count params share the `*nb` gating's 2-char
 * prefix mechanism). */
export function channelRows(def: ParameterDef): readonly ChanRow[] {
  const prefix = def.name.slice(0, 2)
  const chanCount = paramValues(paramDef(`${prefix}cc`))[0] ?? 0
  const bandCount = paramValues(paramDef(`${prefix}nb`))[0] ?? 0
  const values = paramValues(def)
  const stride = 1 + bandCount
  const rows: ChanRow[] = []
  for (let chan = 0; chan < chanCount; chan += 1) {
    const at = chan * stride
    if (at + stride > values.length) break
    rows.push({
      id: values[at] ?? 0,
      at: at + 1,
      gains: values.slice(at + 1, at + stride),
    })
  }
  return rows
}

/** Seat over one `aobg` channel's gains — absolute-offset writes of
 * the head up to the channel's end. */
export function chanSeat(def: ParameterDef, row: Accessor<ChanRow>): ArraySeat {
  const count = (): number => row().gains.length
  const raws = (): readonly number[] => row().gains
  if (!isWritable(def)) return { def, count, raws }
  return {
    def,
    count,
    raws,
    write: (values, live) => {
      const at = row().at
      const next = [...paramValues(def).slice(0, at + values.length)]
      values.forEach((raw, slot) => {
        next[at + slot] = raw
      })
      ;(live ? liveParam : commitParam)(def, next)
    },
  }
}

const slotList = (count: number): readonly number[] =>
  Array.from({ length: count }, (_slot, i) => i)

// — The one strip shape —

const ENGAGE_PX = 3

/** One brush sample: a band index and the raw value under the pointer. */
interface Sample {
  readonly band: number
  readonly raw: number
}

/** The composite widget over a seat: per-band elements (bar + editor)
 * inside the one focusable, paintable strip. */
const Strip: Component<{
  seat: ArraySeat
  /** Accessible name prefix for the band inputs. */
  name: string
  /** Meta-line prefix (`aobg`: the channel). */
  prefix?: string | undefined
  idFor: (slot: number) => string
  /** Publishes the meta text for the described band (undefined = none). */
  onDescribe: (text: string | undefined) => void
}> = (props) => {
  const def = props.seat.def
  const suffix = unitOf(def)
  const writable = props.seat.write !== undefined
  const count = (): number => props.seat.count()
  const raw = (slot: number): number => props.seat.raws()[slot] ?? def.min
  const clampRaw = (value: number): number =>
    Math.min(def.max, Math.max(def.min, value))
  /** Nudge coarse step in raw units (the scrub's coarse display step). */
  const coarseRaw = Math.max(1, displayToRaw(coarseStep(def), def.frac_bits))
  const tip = (slot: number): string => {
    const text = `${def.name}[${String(slot + 1)}] = ${String(display(def, raw(slot)))}`
    return suffix === '' ? text : `${text} ${suffix}`
  }
  const describe = (slot: number): string => {
    const value = String(display(def, raw(slot)))
    const band = `band ${String(slot + 1)} · ${suffix === '' ? value : `${value} ${suffix}`}`
    return props.prefix === undefined ? band : `${props.prefix} · ${band}`
  }
  const withSlot = (slot: number, value: number): readonly number[] => {
    const next = [...props.seat.raws()]
    next[slot] = value
    return next
  }

  // — Roving state —
  const [active, setActive] = createSignal(0)
  const [editing, setEditing] = createSignal<number>()
  const [hover, setHover] = createSignal<number>()
  const [focused, setFocused] = createSignal(false)
  const inputs: HTMLInputElement[] = []
  let strip!: HTMLDivElement

  // The active band stays inside the effective count.
  createEffect(() => {
    const last = count() - 1
    if (active() > last) setActive(Math.max(0, last))
  })
  // The described band: hovered > editing > active while focused.
  createEffect(() => {
    const slot = hover() ?? editing() ?? (focused() ? active() : undefined)
    props.onDescribe(slot === undefined ? undefined : describe(slot))
  })

  const openEditor = (slot: number): void => {
    setActive(slot)
    const input = inputs[slot]
    if (!input) return
    input.focus()
    input.select()
  }

  const nudge = (direction: 1 | -1, fine: boolean): void => {
    if (!writable) return
    const slot = active()
    const step = fine ? 1 : coarseRaw
    const next = clampRaw(raw(slot) + direction * step)
    if (next !== raw(slot)) props.seat.write?.(withSlot(slot, next), false)
  }

  const inEditor = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest('.adv-bands__editor') !== null

  /** The band element under an event target (any layout). */
  const bandAt = (target: EventTarget | null): number | undefined => {
    const band =
      target instanceof Element ? target.closest('.adv-bands__band') : null
    const slot = band ? Array.prototype.indexOf.call(strip.children, band) : -1
    return slot >= 0 ? slot : undefined
  }

  // — Brush state —
  let pointer: number | null = null
  let origin = { x: 0, y: 0 }
  let anchor: Sample | null = null
  let last: Sample | null = null
  let painting = false
  let next: number[] = []

  /** Pointer → (band, raw): x across the band columns, y within the
   * band height (top = max, bottom = min), one raw unit resolution.
   * Null when the bands don't form one row (a wrapped cell grid). */
  const locate = (event: PointerEvent): Sample | null => {
    const n = count()
    const first = strip.children[0]
    const final = strip.children[n - 1]
    if (n === 0 || !first || !final) return null
    const a = first.getBoundingClientRect()
    const z = final.getBoundingClientRect()
    if (Math.abs(a.top - z.top) > 1) return null
    const fx = (event.clientX - a.left) / (z.right - a.left || 1)
    const band = Math.min(n - 1, Math.max(0, Math.floor(fx * n)))
    const fy = Math.min(
      1,
      Math.max(0, (a.bottom - event.clientY) / (a.height || 1)),
    )
    return { band, raw: Math.round(def.min + fy * (def.max - def.min)) }
  }

  /** Paints from the previous sample to this one, every band between
   * interpolated, and pushes the whole array live. */
  const paintTo = (sample: Sample): void => {
    const from = last ?? sample
    const span = sample.band - from.band
    const lo = Math.min(from.band, sample.band)
    const hi = Math.max(from.band, sample.band)
    for (let band = lo; band <= hi; band += 1) {
      const t = span === 0 ? 1 : (band - from.band) / span
      next[band] = Math.round(from.raw + (sample.raw - from.raw) * t)
    }
    last = sample
    props.seat.write?.(next, true)
  }

  const release = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) return
    pointer = null
    strip.releasePointerCapture(event.pointerId)
    if (painting) {
      painting = false
      props.seat.write?.(next, false)
      return
    }
    // A plain click: open the band's editor.
    if (anchor) openEditor(anchor.band)
  }

  return (
    <div
      ref={strip}
      class="adv-bands__strip"
      role="group"
      tabindex="0"
      aria-label={props.name}
      style={{ '--count': String(count()) }}
      onFocusIn={(event) => {
        if (event.target === strip) {
          setFocused(true)
          return
        }
        const slot = inputs.indexOf(event.target as HTMLInputElement)
        if (slot >= 0) {
          setEditing(slot)
          setActive(slot)
        }
      }}
      onFocusOut={(event) => {
        if (event.target === strip) setFocused(false)
        else if (inputs.includes(event.target as HTMLInputElement)) {
          setEditing(undefined)
        }
      }}
      onKeyDown={(event) => {
        const key = event.key
        if (event.target !== strip) {
          // Inside an editor: the box already committed (Enter) or
          // reverted (Esc) and blurred — bring focus home.
          if ((key === 'Enter' || key === 'Escape') && inEditor(event.target)) {
            strip.focus()
          }
          return
        }
        const lastSlot = count() - 1
        if (key === 'ArrowLeft') setActive(Math.max(0, active() - 1))
        else if (key === 'ArrowRight')
          setActive(Math.min(lastSlot, active() + 1))
        else if (key === 'ArrowUp') nudge(1, event.shiftKey)
        else if (key === 'ArrowDown') nudge(-1, event.shiftKey)
        else if (key === 'Home') setActive(0)
        else if (key === 'End') setActive(Math.max(0, lastSlot))
        else if (key === 'Enter') openEditor(active())
        else if (/^[\d.-]$/.test(key) && writable) {
          // Type-to-edit: the keystroke becomes the box's whole text.
          openEditor(active())
          const input = inputs[active()]
          if (input) {
            input.value = key
            input.setSelectionRange(1, 1)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
        } else return
        event.preventDefault()
        event.stopPropagation()
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || pointer !== null || inEditor(event.target)) {
          return
        }
        const sample = locate(event)
        if (!sample) return
        pointer = event.pointerId
        origin = { x: event.clientX, y: event.clientY }
        anchor = sample
        painting = false
        strip.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (pointer === null) {
          setHover(bandAt(event.target))
          return
        }
        if (event.pointerId !== pointer) return
        if (!painting) {
          if (!writable) return
          const moved = Math.hypot(
            event.clientX - origin.x,
            event.clientY - origin.y,
          )
          if (moved < ENGAGE_PX) return
          painting = true
          last = null
          next = [...props.seat.raws()]
          if (anchor) paintTo(anchor)
        }
        const sample = locate(event)
        if (sample) {
          setHover(sample.band)
          paintTo(sample)
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={() => {
        setHover(undefined)
      }}
      onClick={(event) => {
        // The click lands on the strip — not interactive content, so
        // the card label would forward it to band 1's box.
        if (!inEditor(event.target)) event.preventDefault()
      }}
    >
      <For each={slotList(count())}>
        {(slot) => (
          <div
            class="adv-bands__band"
            classList={{
              'adv-bands__band--active': active() === slot,
              'adv-bands__band--editing': editing() === slot,
              'adv-bands__band--hover': hover() === slot,
            }}
            title={tip(slot)}
          >
            <span
              class="adv-bands__bar"
              aria-hidden="true"
              style={{
                '--value': String(display(def, raw(slot))),
                '--norm': String(norm(def, raw(slot))),
              }}
            />
            <span class="adv-bands__editor">
              <NumberInput
                id={props.idFor(slot)}
                name={`${props.name} band ${String(slot + 1)}`}
                readOnly={!writable}
                scrub={writable}
                tabIndex={-1}
                ref={(input) => {
                  inputs[slot] = input
                }}
                value={() => display(def, raw(slot))}
                min={rawToDisplay(def.min, def.frac_bits)}
                max={rawToDisplay(def.max, def.frac_bits)}
                coarse={coarseStep(def)}
                fine={fineStep(def)}
                unit=""
                onLive={(value) =>
                  props.seat.write?.(withSlot(slot, toRaw(def, value)), true)
                }
                onCommit={(value) =>
                  props.seat.write?.(withSlot(slot, toRaw(def, value)), false)
                }
              />
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

// — The container —

/** Unit suffix — `aobg` is 1/16-dB gains under a layout kind, so its
 * label comes from here rather than `unitLabel`. */
const unitOf = (def: ParameterDef): string =>
  def.kind === 'aobg_channel_major' ? 'dB' : unitLabel(def.kind)

const BandArray: Component<{ def: ParameterDef; name: string }> = (props) => {
  const def = props.def
  const suffix = unitOf(def)
  const readOnly = !isWritable(def)
  const live = def.access === 'read_only_dynamic'
  const withUnit = (text: string): string =>
    suffix === '' ? text : `${text} · ${suffix}`
  const modifiers = {
    'adv-bands--ro': readOnly,
    'adv-bands--live': live,
    'adv-bands--opaque': def.kind === 'opaque',
  }

  // One meta line per card; each strip publishes its described band.
  const [infos, setInfos] = createSignal<readonly (string | undefined)[]>([])
  const describe =
    (row: number) =>
    (text: string | undefined): void => {
      setInfos((prev) => {
        const next = [...prev]
        next[row] = text
        return next
      })
    }
  const focusText = (): string | undefined =>
    infos().find((text) => text !== undefined)

  if (def.kind === 'aobg_channel_major') {
    const rows = createMemo(() => channelRows(def))
    const summary = (): string => {
      const bands = rows()[0]?.gains.length ?? 0
      return withUnit(
        `${String(rows().length)} channels × ${String(bands)} bands`,
      )
    }
    return (
      <div class="adv-bands" classList={modifiers}>
        <Index
          each={rows()}
          fallback={
            <span class="adv-bands__empty">no channels configured</span>
          }
        >
          {(row, chan) => (
            <div class="adv-bands__row">
              <span
                class="adv-bands__chan"
                title={`engine channel id ${String(row().id)}`}
              >
                ch {String(row().id)}
              </span>
              <Strip
                seat={chanSeat(def, row)}
                name={`${props.name} channel ${String(row().id)}`}
                prefix={`ch ${String(row().id)}`}
                idFor={(slot) => bandId(def, slot, chan)}
                onDescribe={describe(chan)}
              />
            </div>
          )}
        </Index>
        <div class="adv-bands__meta" aria-live="polite">
          {focusText() ?? summary()}
        </div>
      </div>
    )
  }

  const seat = live ? liveSeat(def) : bandSeat(def)
  const summary = (): string =>
    def.kind === 'opaque'
      ? withUnit(`${String(def.length)} values`)
      : withUnit(`${String(seat.count())} of ${String(def.length)} bands`)
  return (
    <div class="adv-bands" classList={modifiers}>
      <div class="adv-bands__row">
        <Strip
          seat={seat}
          name={props.name}
          idFor={(slot) => bandId(def, slot)}
          onDescribe={describe(0)}
        />
      </div>
      <div class="adv-bands__meta" aria-live="polite">
        {focusText() ?? summary()}
      </div>
    </div>
  )
}

export default BandArray
