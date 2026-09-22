import { For, createSignal, type Component } from 'solid-js'
import { unitLabel, type ParameterDef } from '../lib/parameters'
import { displayValue, fineStep, scaleOf } from '../lib/scalar'
import type { StepAxis } from '../lib/step'
import { effectiveCount, isWritable, paramValues } from '../store/wiring'
import NumberInput from './NumberInput'

/** One band's editor id — the card's `for` target on band 0. */
export function bandInputId(def: ParameterDef, slot: number): string {
  return `adv-${def.name}-b${String(slot)}`
}

/** 0–1 of the def's raw range — the bar's height, always linear
 * (a log axis is a stepping / Slider concern, never a bar's). */
const norm = (def: ParameterDef, raw: number): number =>
  (raw - def.min) / (def.max - def.min || 1)

const slots = (count: number): readonly number[] =>
  Array.from({ length: count }, (_slot, slot) => slot)

/**
 * The Band strip (#90), a shared control — the one DOM every
 * `length > 1` param renders; kind decides structure, access gates
 * editability. One `role=group` strip, one Tab stop, holding
 * `effectiveCount` bands (`--count`): each a bar publishing `--value`
 * (display units) and `--norm` (linear over `[min, max]`) plus an
 * editor — the numeric box, `tabindex=-1`, `readonly` until band
 * editing lands (#91). Hover marks the band (`--hover`) and puts
 * `band N · value unit` on the meta line; leaving restores the count
 * summary. `--ro` mirrors a read-only bucket. Values through the
 * Source rule (`paramValues`); no layout policy — the skin lays the
 * bands out (ADR-0011). Part 2 adds `aobg` channel rows, `--live`,
 * `--opaque`.
 */
const BandArray: Component<{ def: ParameterDef; name: string }> = (props) => {
  // Static per card, like the factory's `def`.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  const unit = unitLabel(def.kind)
  const withUnit = (text: string): string =>
    unit === '' ? text : `${text} ${unit}`
  const count = (): number => effectiveCount(def)
  const raw = (slot: number): number => paramValues(def)[slot] ?? def.min
  const value = (slot: number): number => displayValue(def, raw(slot))
  const axis: StepAxis = {
    min: displayValue(def, def.min),
    max: displayValue(def, def.max),
    fine: fineStep(def),
    scale: scaleOf(def),
  }

  const [hover, setHover] = createSignal<number>()
  let strip!: HTMLDivElement

  /** The band under an event target, by position in the strip. */
  const bandAt = (target: EventTarget | null): number | undefined => {
    const band =
      target instanceof Element ? target.closest('.adv-bands__band') : null
    const slot = band ? Array.prototype.indexOf.call(strip.children, band) : -1
    return slot >= 0 ? slot : undefined
  }

  const summary = (): string => {
    const text = `${String(count())} of ${String(def.length)} bands`
    return unit === '' ? text : `${text} · ${unit}`
  }
  const meta = (): string => {
    const slot = hover()
    if (slot === undefined) return summary()
    return `band ${String(slot + 1)} · ${withUnit(String(value(slot)))}`
  }

  return (
    <div class="adv-bands" classList={{ 'adv-bands--ro': !isWritable(def) }}>
      <div class="adv-bands__row">
        <div
          ref={strip}
          class="adv-bands__strip"
          role="group"
          tabindex="0"
          aria-label={props.name}
          style={{ '--count': String(count()) }}
          onPointerMove={(event) => {
            setHover(bandAt(event.target))
          }}
          onPointerLeave={() => {
            setHover(undefined)
          }}
        >
          <For each={slots(count())}>
            {(slot) => (
              <span
                class="adv-bands__band"
                classList={{ 'adv-bands__band--hover': hover() === slot }}
                title={`${def.name}[${String(slot + 1)}] = ${withUnit(String(value(slot)))}`}
              >
                <span
                  class="adv-bands__bar"
                  aria-hidden="true"
                  style={{
                    '--value': String(value(slot)),
                    '--norm': String(norm(def, raw(slot))),
                  }}
                />
                <span class="adv-bands__editor">
                  <NumberInput
                    id={bandInputId(def, slot)}
                    name={`${props.name} band ${String(slot + 1)}`}
                    value={() => value(slot)}
                    axis={axis}
                    unit=""
                    readOnly
                    tabIndex={-1}
                  />
                </span>
              </span>
            )}
          </For>
        </div>
      </div>
      <div class="adv-bands__meta" aria-live="polite">
        {meta()}
      </div>
    </div>
  )
}

export default BandArray
