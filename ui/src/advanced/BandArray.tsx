// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * THE unified long-array DOM every skin restyles: a bands container >
 * per-band elements, each publishing `--value` (display units) and
 * `--norm` (0–1 of the def's raw range). Kind decides structure,
 * access gates editability: writable bands hold a real focusable
 * ScrubInput (type-to-edit + vertical scrub); read-only bands hold a
 * text value span — same shape for band arrays, read-only arrays
 * (`vnbf`, `bver`, …), live vis arrays (fed from the vis frame signal,
 * NO idle state — cards just hold the last frame), and channel-major
 * `aobg` rows. Skin A paints bar strips (input text hidden with
 * `opacity`, never `display` — hidden chrome stays focusable,
 * ADR-0011), B numeric cells, C plot-styled bands.
 */
import { For, Index, createMemo, type Accessor, type Component } from 'solid-js'
import { paramDef, unitLabel, type ParameterDef } from '../lib/parameters'
import { displayToRaw, rawToDisplay } from '../lib/units'
import type { VisParams } from '../lib/ws'
import { visFrame } from '../store/vis'
import ScrubInput from './ScrubInput'
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

// — Seats —

/** One array surface: a band array, an `aobg` channel, a live vis
 * array. `set` absent = read-only (kind decides structure, access
 * gates editability). */
export interface ArraySeat {
  readonly def: ParameterDef
  readonly count: () => number
  readonly raws: () => readonly number[]
  /** Absent = read-only. `live` = mid-drag; false = commit. */
  readonly set?: (slot: number, raw: number, live: boolean) => void
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
    set: (slot, raw, live) => {
      const next = [...raws()]
      next[slot] = raw
      ;(live ? liveParam : commitParam)(def, next)
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

/** Seat over one `aobg` channel's gains — absolute-offset writes. */
export function chanSeat(def: ParameterDef, row: Accessor<ChanRow>): ArraySeat {
  const count = (): number => row().gains.length
  const raws = (): readonly number[] => row().gains
  if (!isWritable(def)) return { def, count, raws }
  return {
    def,
    count,
    raws,
    set: (slot, raw, live) => {
      const at = row().at
      const next = [
        ...paramValues(def).slice(0, Math.max(at + count(), at + slot + 1)),
      ]
      next[at + slot] = raw
      ;(live ? liveParam : commitParam)(def, next)
    },
  }
}

const slotList = (count: number): readonly number[] =>
  Array.from({ length: count }, (_slot, i) => i)

// — The one strip shape —

/** Per-band elements over a seat — vars + input/value inside each. */
const Strip: Component<{ seat: ArraySeat }> = (props) => {
  const def = props.seat.def
  const suffix = unitLabel(def.kind)
  const editable = props.seat.set !== undefined
  const raw = (slot: number): number => props.seat.raws()[slot] ?? def.min
  const tip = (slot: number): string => {
    const text = `${def.name}[${String(slot + 1)}] = ${String(display(def, raw(slot)))}`
    return suffix === '' ? text : `${text} ${suffix}`
  }
  return (
    <div
      class="adv-bands__strip"
      style={{ '--count': String(props.seat.count()) }}
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
            {editable ? (
              <ScrubInput
                label={`${def.label} band ${String(slot + 1)}`}
                value={() => display(def, raw(slot))}
                min={rawToDisplay(def.min, def.frac_bits)}
                max={rawToDisplay(def.max, def.frac_bits)}
                coarse={coarseStep(def)}
                fine={fineStep(def)}
                onLive={(value) =>
                  props.seat.set?.(slot, toRaw(def, value), true)
                }
                onCommit={(value) =>
                  props.seat.set?.(slot, toRaw(def, value), false)
                }
              />
            ) : (
              <span class="adv-bands__value">
                {String(display(def, raw(slot)))}
              </span>
            )}
          </span>
        )}
      </For>
    </div>
  )
}

// — The container —

const BandArray: Component<{ def: ParameterDef }> = (props) => {
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
          {(row) => (
            <div class="adv-bands__row">
              <span class="adv-bands__chan">ch {String(row().id)}</span>
              <Strip seat={chanSeat(def, row)} />
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
        <Strip seat={seat} />
      </div>
      <div class="adv-bands__meta">
        {withUnit(`${String(seat.count())} of ${String(def.length)} bands`)}
      </div>
    </div>
  )
}

export default BandArray
