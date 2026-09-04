// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * THE unified long-array DOM every skin restyles: a bands container >
 * per-band elements, each publishing `--value` (display units) and
 * `--norm` (0–1 of the def's raw range) and holding the one numeric
 * box (writable: typed edits commit live; read-only: `readonly`) —
 * same shape for band arrays, read-only arrays (`vnbf`, `bver`, …),
 * live vis arrays (fed from the vis frame signal, NO idle state) and
 * channel-major `aobg` rows.
 *
 * Writable strips are PAINTABLE (no pointer lock): pointerdown arms
 * and captures; > 3 px of movement engages the brush, then every
 * pointermove maps x over the bands → band index and y within the
 * band's height → value (max at top, min at bottom), painting every
 * band crossed since the last event (interpolated across skipped
 * bands, so a fast drag leaves no gaps) as ONE live write of the
 * whole array per event; release commits. A click without drag hands
 * the band under the pointer to the keyboard (focuses its input). The
 * mapping assumes a skin lays bands out as one horizontal row of
 * equal columns (A / C); a wrapping cell grid (B) paints nonsense.
 */
import { For, Index, createMemo, type Accessor, type Component } from 'solid-js'
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

/** Scrub coarse step: 1 display unit, range-scaled so wide ranges
 * (20 kHz) stay traversable — ~256 steps across the span. */
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

/** `aobg`-layout parse — channel-major `[chan_id, gains…]`, the count
 * params derived from the same 2-char-prefix mechanism as `*nb` gating
 * (`aocc` / `aonb`); terminator-aware (AK_CHAN_EMPTY unknown; guessed
 * as any negative id). */
export interface ChanRow {
  readonly id: number
  readonly at: number
  readonly gains: readonly number[]
}

export function channelRows(def: ParameterDef): readonly ChanRow[] {
  const prefix = def.name.slice(0, 2)
  const chanCount = paramValues(paramDef(`${prefix}cc`))[0] ?? 0
  const bandCount = paramValues(paramDef(`${prefix}nb`))[0] ?? 0
  const values = paramValues(def)
  const rows: ChanRow[] = []
  let pos = 0
  for (let chan = 0; chan < chanCount; chan += 1) {
    const id = values[pos]
    if (id === undefined || id < 0) break
    rows.push({
      id,
      at: pos + 1,
      gains: values.slice(pos + 1, pos + 1 + bandCount),
    })
    pos += 1 + bandCount
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

/** Per-band elements over a seat — vars + the numeric box inside each;
 * the strip itself is the paint surface. */
const Strip: Component<{
  seat: ArraySeat
  /** Accessible name prefix for the band inputs. */
  name: string
  idFor: (slot: number) => string
}> = (props) => {
  const def = props.seat.def
  const suffix = unitLabel(def.kind)
  const writable = props.seat.write !== undefined
  const raw = (slot: number): number => props.seat.raws()[slot] ?? def.min
  const tip = (slot: number): string => {
    const text = `${def.name}[${String(slot + 1)}] = ${String(display(def, raw(slot)))}`
    return suffix === '' ? text : `${text} ${suffix}`
  }
  const withSlot = (slot: number, value: number): readonly number[] => {
    const next = [...props.seat.raws()]
    next[slot] = value
    return next
  }

  // — Brush state —
  let strip!: HTMLDivElement
  let pointer: number | null = null
  let origin = { x: 0, y: 0 }
  let anchor: Sample | null = null
  let last: Sample | null = null
  let painting = false
  let next: number[] = []

  /** Pointer → (band, raw): x across the band columns, y within the
   * band height (top = max, bottom = min), one raw unit resolution. */
  const locate = (event: PointerEvent): Sample | null => {
    const count = props.seat.count()
    const first = strip.children[0]
    const final = strip.children[count - 1]
    if (count === 0 || !first || !final) return null
    const a = first.getBoundingClientRect()
    const z = final.getBoundingClientRect()
    const fx = (event.clientX - a.left) / (z.right - a.left || 1)
    const band = Math.min(count - 1, Math.max(0, Math.floor(fx * count)))
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
    // A plain click: hand the band under the pointer to the keyboard.
    const band = locate(event)?.band
    if (band !== undefined) {
      strip.children[band]?.querySelector('input')?.focus()
    }
  }

  return (
    <div
      ref={strip}
      class="adv-bands__strip"
      style={{ '--count': String(props.seat.count()) }}
      onPointerDown={(event) => {
        if (!writable || event.button !== 0 || pointer !== null) return
        pointer = event.pointerId
        origin = { x: event.clientX, y: event.clientY }
        anchor = locate(event)
        painting = false
        strip.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (event.pointerId !== pointer) return
        if (!painting) {
          const moved = Math.hypot(
            event.clientX - origin.x,
            event.clientY - origin.y,
          )
          if (moved < ENGAGE_PX) return
          painting = true
          last = null
          next = [...props.seat.raws()]
          // pointerdown may have focused a band input — painting is
          // not typing.
          const active = document.activeElement
          if (active instanceof HTMLElement && strip.contains(active)) {
            active.blur()
          }
          if (anchor) paintTo(anchor)
        }
        const sample = locate(event)
        if (sample) paintTo(sample)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onClick={(event) => {
        // The captured click lands on the strip — not interactive
        // content, so the card label would forward it to band 1.
        if (writable) event.preventDefault()
      }}
    >
      <For each={slotList(props.seat.count())}>
        {(slot) => (
          <span
            class="adv-bands__band"
            style={{
              '--value': String(display(def, raw(slot))),
              '--norm': String(norm(def, raw(slot))),
            }}
            title={tip(slot)}
          >
            <NumberInput
              id={props.idFor(slot)}
              name={`${props.name} band ${String(slot + 1)}`}
              readOnly={!writable}
              value={() => display(def, raw(slot))}
              min={rawToDisplay(def.min, def.frac_bits)}
              max={rawToDisplay(def.max, def.frac_bits)}
              unit=""
              onLive={(value) =>
                props.seat.write?.(withSlot(slot, toRaw(def, value)), true)
              }
              onCommit={(value) =>
                props.seat.write?.(withSlot(slot, toRaw(def, value)), false)
              }
            />
          </span>
        )}
      </For>
    </div>
  )
}

// — The container —

const BandArray: Component<{ def: ParameterDef; name: string }> = (props) => {
  const def = props.def
  const suffix = unitLabel(def.kind)
  const readOnly = !isWritable(def)
  const live = def.access === 'read_only_dynamic'
  const withUnit = (text: string): string =>
    suffix === '' ? text : `${text} · ${suffix}`

  if (def.kind === 'aobg_channel_major') {
    const rows = createMemo(() => channelRows(def))
    return (
      <div
        class="adv-bands"
        classList={{ 'adv-bands--ro': readOnly, 'adv-bands--live': live }}
      >
        <Index
          each={rows()}
          fallback={
            <span class="adv-bands__empty">no channels configured</span>
          }
        >
          {(row, chan) => (
            <div class="adv-bands__row">
              <span class="adv-bands__chan">ch {String(row().id)}</span>
              <Strip
                seat={chanSeat(def, row)}
                name={`${props.name} channel ${String(row().id)}`}
                idFor={(slot) => bandId(def, slot, chan)}
              />
            </div>
          )}
        </Index>
        <div class="adv-bands__meta">
          {withUnit(`${String(rows().length)} channels`)}
        </div>
      </div>
    )
  }

  const seat = live ? liveSeat(def) : bandSeat(def)
  return (
    <div
      class="adv-bands"
      classList={{ 'adv-bands--ro': readOnly, 'adv-bands--live': live }}
    >
      <div class="adv-bands__row">
        <Strip
          seat={seat}
          name={props.name}
          idFor={(slot) => bandId(def, slot)}
        />
      </div>
      <div class="adv-bands__meta">
        {withUnit(`${String(seat.count())} of ${String(def.length)} bands`)}
      </div>
    </div>
  )
}

export default BandArray
