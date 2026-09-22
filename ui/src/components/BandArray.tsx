import { For, Index, Show, createSignal, type Component } from 'solid-js'
import { unitLabel, type ParameterDef } from '../lib/parameters'
import { axisOf, displayValue } from '../lib/scalar'
import {
  channelRows,
  effectiveCount,
  isLive,
  isWritable,
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

/** The band under the pointer: its row and its slot. */
interface Hovered {
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

/**
 * One strip — `role=group`, one Tab stop — of `count` bands over a raw
 * source: each a bar publishing `--value` (display units) and `--norm`
 * (linear over `[min, max]`) plus an editor — the numeric box,
 * `tabindex=-1`, `readonly` until band editing lands (#91). Marks the
 * hovered band (`--hover`) and reports it to its container as
 * `{ row, slot }`.
 */
const Strip: Component<{
  def: ParameterDef
  name: string
  row: number
  count: () => number
  raw: (slot: number) => number
  idFor: (slot: number) => string
  hover: () => Hovered | undefined
  onHover: (at: Hovered | undefined) => void
}> = (props) => {
  // Static per strip, like the factory's `def`.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  const axis = axisOf(def)
  const value = (slot: number): number => displayValue(def, props.raw(slot))
  const hovered = (slot: number): boolean => {
    const at = props.hover()
    return at?.row === props.row && at.slot === slot
  }
  let strip!: HTMLDivElement

  /** The band under an event target, by position among the bands. */
  const bandAt = (target: EventTarget | null): Hovered | undefined => {
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
      onPointerMove={(event) => {
        props.onHover(bandAt(event.target))
      }}
      onPointerLeave={() => {
        props.onHover(undefined)
      }}
    >
      <For each={slots(props.count())}>
        {(slot) => (
          <span
            class="adv-bands__band"
            classList={{ 'adv-bands__band--hover': hovered(slot) }}
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
                readOnly
                tabIndex={-1}
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

/** The plain meta: the hovered band, else `count of length bands` —
 * an `opaque` kind counts `values`. */
function plainMeta(def: ParameterDef, at: Hovered | undefined): string {
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

/** The `aobg` meta: the hovered band under its channel, else
 * `channels × bands`; no rows is the empty state. */
function channelMeta(def: ParameterDef, at: Hovered | undefined): string {
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
 * The Band strip (#90), a shared control — the one DOM every
 * `length > 1` param renders; kind decides structure, access gates
 * editability. Rows of `role=group` strips — one of `effectiveCount`
 * bands over the Source rule's values, or one per packed `aobg`
 * channel set (`channelRows`) labelled `ch <id>` from the data — each
 * band a bar publishing `--value` / `--norm` plus a `readonly`,
 * `tabindex=-1` editor until band editing lands (#91). Hover marks a
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
  const [hover, setHover] = createSignal<Hovered>()
  const meta = (): string =>
    channelMajor ? channelMeta(def, hover()) : plainMeta(def, hover())
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
              hover={hover}
              onHover={setHover}
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
                hover={hover}
                onHover={setHover}
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
