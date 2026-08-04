// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The array widgets the variants brainstorm across: Bars (variant A —
 * editable mini-GEQ strip, drag-to-shape), Cells (variant B — dense
 * scrub/type cell grid), DynPlot (ReadOnly-Dynamic vis arrays — live
 * bar plots off the vis frame signal, Visualizer.tsx's pattern), plus
 * the channel-major `aobg` layout. All read/write through an
 * [`ArraySeat`] so plain band arrays and per-channel `aobg` slices
 * share the same widgets.
 */
import {
  For,
  Index,
  createMemo,
  createSignal,
  type Accessor,
  type Component,
} from 'solid-js'
import { paramDef, unitLabel, type ParameterDef } from '../lib/parameters'
import { displayToRaw, rawToDisplay } from '../lib/units'
import type { VisParams } from '../lib/ws'
import { visFrame, visIdle } from '../store/vis'
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

/** Scrub fine (Shift) step: one raw unit. */
export const fineStep = (def: ParameterDef): number =>
  rawToDisplay(1, def.frac_bits)

// — Seats —

/** One editable array surface: a band array, or one `aobg` channel. */
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
    rows.push({ id, at: pos + 1, gains: values.slice(pos + 1, pos + 1 + bandCount) })
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
      const next = [...paramValues(def).slice(0, Math.max(at + count(), at + slot + 1))]
      next[at + slot] = raw
      ;(live ? liveParam : commitParam)(def, next)
    },
  }
}

const slotList = (count: number): readonly number[] =>
  Array.from({ length: count }, (_slot, i) => i)

// — Bars (variant A + composite rows) —

/**
 * Editable bar strip — vertical bars publishing `--v` (0–1 of the
 * param's raw range; skin CSS paints the height), drag-to-shape across
 * bands, hover/drag readout with index + exact value in the meta line.
 */
export const Bars: Component<{ seat: ArraySeat }> = (props) => {
  let strip!: HTMLDivElement
  const def = props.seat.def
  const editable = props.seat.set !== undefined
  const [probe, setProbe] = createSignal<{ slot: number; raw: number }>()
  let dragging = false
  let lastHit: { slot: number; raw: number } | undefined

  const span = def.max - def.min || 1
  const norm = (raw: number): number => (raw - def.min) / span

  const hitAt = (
    event: PointerEvent,
  ): { slot: number; raw: number } | undefined => {
    const rect = strip.getBoundingClientRect()
    const count = props.seat.count()
    if (count === 0 || rect.width === 0) return undefined
    const slot = Math.min(
      count - 1,
      Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * count)),
    )
    const frac = Math.min(
      1,
      Math.max(0, 1 - (event.clientY - rect.top) / rect.height),
    )
    return { slot, raw: def.min + Math.round(frac * span) }
  }

  const meta = (): string => {
    const suffix = unitLabel(def.kind)
    const hit = probe()
    if (hit) {
      const text = `#${String(hit.slot + 1)} · ${String(display(def, hit.raw))}`
      return suffix === '' ? text : `${text} ${suffix}`
    }
    const text = `${String(props.seat.count())} of ${String(def.length)} bands`
    return suffix === '' ? text : `${text} · ${suffix}`
  }

  return (
    <div class="adv-strip" classList={{ 'adv-strip--static': !editable }}>
      <div
        class="adv-strip__bars"
        ref={strip}
        onPointerDown={(event) => {
          if (!editable || event.button !== 0) return
          strip.setPointerCapture(event.pointerId)
          dragging = true
          const hit = hitAt(event)
          if (hit) {
            lastHit = hit
            props.seat.set?.(hit.slot, hit.raw, true)
            setProbe(hit)
          }
          event.preventDefault()
        }}
        onPointerMove={(event) => {
          const hit = hitAt(event)
          if (!hit) return
          if (dragging) {
            lastHit = hit
            props.seat.set?.(hit.slot, hit.raw, true)
            setProbe(hit)
          } else {
            setProbe({ slot: hit.slot, raw: props.seat.raws()[hit.slot] ?? 0 })
          }
        }}
        onPointerUp={(event) => {
          if (!dragging) return
          dragging = false
          strip.releasePointerCapture(event.pointerId)
          if (lastHit) props.seat.set?.(lastHit.slot, lastHit.raw, false)
        }}
        onPointerLeave={() => {
          if (!dragging) setProbe(undefined)
        }}
      >
        <For each={slotList(props.seat.count())}>
          {(slot) => (
            <span
              class="adv-strip__bar"
              style={{
                '--v': String(norm(props.seat.raws()[slot] ?? def.min)),
              }}
            />
          )}
        </For>
      </div>
      <div class="adv-strip__meta">{meta()}</div>
    </div>
  )
}

// — Cells (variant B) —

/** Dense monospace numeric cell grid — each cell scrubbable + typeable. */
export const Cells: Component<{ seat: ArraySeat }> = (props) => {
  const def = props.seat.def
  const suffix = unitLabel(def.kind)
  return (
    <div class="adv-cells">
      <For each={slotList(props.seat.count())}>
        {(slot) => (
          <ScrubInput
            compact
            label={`${def.label} band ${String(slot + 1)}`}
            title={`${def.name}[${String(slot + 1)}]${suffix === '' ? '' : ` — ${suffix}`}`}
            value={() => display(def, props.seat.raws()[slot] ?? 0)}
            min={rawToDisplay(def.min, def.frac_bits)}
            max={rawToDisplay(def.max, def.frac_bits)}
            coarse={coarseStep(def)}
            fine={fineStep(def)}
            onLive={(value) => props.seat.set?.(slot, toRaw(def, value), true)}
            onCommit={(value) => props.seat.set?.(slot, toRaw(def, value), false)}
          />
        )}
      </For>
      <span class="adv-cells__meta">
        {String(props.seat.count())} of {String(def.length)} bands
        {suffix === '' ? '' : ` · ${suffix}`}
      </span>
    </div>
  )
}

// — DynPlot (ReadOnly-Dynamic vis arrays) —

/** Live bar plot off the vis frame signal — per-band elements carrying
 * `--db` (skin CSS maps it to a height; Visualizer.tsx's pattern). */
export const DynPlot: Component<{ def: ParameterDef }> = (props) => {
  const key = props.def.name as keyof VisParams
  const bands = (): readonly number[] | undefined => {
    if (visIdle()) return undefined
    return visFrame()?.[key].slice(0, effectiveCount(props.def))
  }
  return (
    <div class="adv-plot">
      <For
        each={bands()}
        fallback={<span class="adv-plot__idle">feed idle</span>}
      >
        {(raw) => (
          <span
            class="adv-plot__bar"
            style={{ '--db': String(rawToDisplay(raw, props.def.frac_bits)) }}
            title={`${String(display(props.def, raw))} dB`}
          />
        )}
      </For>
    </div>
  )
}

// — Aobg (variants A / B; the composite renders its own channel rows) —

/** Channel-major rows: channel id + that channel's gains as the
 * variant's array widget. */
export const Aobg: Component<{ def: ParameterDef; mode: 'strip' | 'cells' }> = (
  props,
) => {
  const rows = createMemo(() => channelRows(props.def))
  return (
    <div class="adv-chans">
      <Index
        each={rows()}
        fallback={<span class="adv-chans__empty">no channels configured</span>}
      >
        {(row) => (
          <div class="adv-chans__row">
            <span class="adv-chans__id">ch {String(row().id)}</span>
            {props.mode === 'cells' ? (
              <Cells seat={chanSeat(props.def, row)} />
            ) : (
              <Bars seat={chanSeat(props.def, row)} />
            )}
          </div>
        )}
      </Index>
    </div>
  )
}
