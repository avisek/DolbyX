import {
  For,
  Index,
  Show,
  createSignal,
  type Accessor,
  type Component,
} from 'solid-js'
import { unitLabel, type ParameterDef } from '../lib/parameters'
import { axisOf, displayValue } from '../lib/scalar'
import {
  channelRows,
  effectiveCount,
  isWritable,
  paramValues,
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
const describe = (def: ParameterDef, slot: number, raw: number): string =>
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
  hover: Accessor<Hovered | undefined>
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

/** The props the two shapes share with their container. */
interface ShapeProps {
  def: ParameterDef
  name: string
  hover: Accessor<Hovered | undefined>
  onHover: (at: Hovered | undefined) => void
}

/**
 * The plain shape: one row, one strip of `effectiveCount` bands over
 * the Source rule's values; an Opaque blob summarises as `N values`,
 * anything else as `count of length bands`.
 */
const PlainBands: Component<ShapeProps> = (props) => {
  // Static per card, like the factory's `def`.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  const count = (): number => effectiveCount(def)
  // A source shorter than the count (a snapshot carrying fewer slots
  // than the allocation) reads the table default for the tail.
  const raw = (slot: number): number =>
    paramValues(def)[slot] ?? def.default[slot] ?? def.min
  const summary = (): string =>
    def.kind === 'opaque'
      ? withUnit(def, `${String(def.length)} values`, ' · ')
      : withUnit(
          def,
          `${String(count())} of ${String(def.length)} bands`,
          ' · ',
        )
  const meta = (): string => {
    const at = props.hover()
    return at ? describe(def, at.slot, raw(at.slot)) : summary()
  }
  return (
    <>
      <div class="adv-bands__row">
        <Strip
          def={def}
          name={props.name}
          row={0}
          count={count}
          raw={raw}
          idFor={(slot) => bandInputId(def, slot)}
          hover={props.hover}
          onHover={props.onHover}
        />
      </div>
      <div class="adv-bands__meta" aria-live="polite">
        {meta()}
      </div>
    </>
  )
}

/**
 * The `aobg` (`AobgChannelMajor`) shape: one row per packed channel
 * set (`channelRows`), each labelled `ch <id>` from the data, its
 * strip the set's gains; the meta reads `channels × bands`, the
 * hovered band prefixed by its channel. No rows is the empty state.
 */
const ChannelBands: Component<ShapeProps> = (props) => {
  // Static per card, like the factory's `def`.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  const rows = () => channelRows(def)
  const summary = (): string => {
    const found = rows()
    const bands = found[0]?.gains.length
    if (bands === undefined) return 'no channels configured'
    return withUnit(
      def,
      `${String(found.length)} channels × ${String(bands)} bands`,
      ' · ',
    )
  }
  const meta = (): string => {
    const at = props.hover()
    const row = at && rows()[at.row]
    if (!at || !row) return summary()
    const gain = row.gains[at.slot] ?? def.min
    return `ch ${String(row.id)} · ${describe(def, at.slot, gain)}`
  }
  return (
    <>
      <Index each={rows()}>
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
              raw={(slot) => row().gains[slot] ?? def.min}
              idFor={(slot) => bandInputId(def, slot, chan)}
              hover={props.hover}
              onHover={props.onHover}
            />
          </div>
        )}
      </Index>
      <div class="adv-bands__meta" aria-live="polite">
        {meta()}
      </div>
    </>
  )
}

/**
 * The Band strip (#90), a shared control — the one DOM every
 * `length > 1` param renders; kind decides structure, access gates
 * editability. Rows of `role=group` strips — one, or one per `aobg`
 * channel — each band a bar publishing `--value` / `--norm` plus a
 * `readonly`, `tabindex=-1` editor until band editing lands (#91).
 * Hover marks a band and describes it on the meta line; leaving
 * restores the summary. Modifiers from access — `--ro` for either
 * read-only bucket, `--live` for the Live arrays (the last `vis`
 * frame held, no idle state), `--opaque` for the blobs the skin draws
 * as cells. Values through the Source rule (`paramValues`); no layout
 * policy — the skin lays the bands out (ADR-0011).
 */
const BandArray: Component<{ def: ParameterDef; name: string }> = (props) => {
  // Static per card, like the factory's `def`.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  const [hover, setHover] = createSignal<Hovered>()
  return (
    <div
      class="adv-bands"
      classList={{
        'adv-bands--ro': !isWritable(def),
        'adv-bands--live': def.access === 'read_only_dynamic',
        'adv-bands--opaque': def.kind === 'opaque',
      }}
    >
      <Show
        when={isChannelMajor(def)}
        fallback={
          <PlainBands
            def={def}
            name={props.name}
            hover={hover}
            onHover={setHover}
          />
        }
      >
        <ChannelBands
          def={def}
          name={props.name}
          hover={hover}
          onHover={setHover}
        />
      </Show>
    </div>
  )
}

export default BandArray
