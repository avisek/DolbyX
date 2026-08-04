// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * Variant C's composite band plot: sibling band arrays stacked as
 * aligned rows (fixed gutter + `1fr` plot, same band count) over ONE
 * shared frequency axis — the `*bf` array is the x-axis tick labels,
 * not a standalone widget. The bf param keeps its own 4-CC / label /
 * divergence dot / reset in the axis caption (nothing dropped); its
 * VALUES are edited in variants A/B, not via the axis. Dynamic rows
 * plot live off the vis feed; `aobg` explodes into per-channel rows.
 */
import { For, Index, Show, createMemo, type Component } from 'solid-js'
import { paramDef, type ParameterDef } from '../lib/parameters'
import { rawToDisplay } from '../lib/units'
import {
  Bars,
  DynPlot,
  bandSeat,
  chanSeat,
  channelRows,
} from './BandWidgets'
import {
  canResetParam,
  effectiveCount,
  paramDiverged,
  paramValues,
  resetParam,
} from './wiring'

/** A row's (or the axis's) compact head, in the shared gutter column. */
const Gutter: Component<{ def: ParameterDef }> = (props) => {
  const def = props.def
  const readOnly =
    def.access === 'read_only_static' || def.access === 'read_only_dynamic'
  return (
    <div
      class="adv-comp__gutter"
      classList={{ 'adv-comp__gutter--diverged': paramDiverged(def) }}
      title={def.description}
    >
      <div class="adv-comp__id">
        <code class="adv-card__code">{def.name}</code>
        <Show when={def.access === 'experimental'}>
          <span class="adv-badge">Exp</span>
        </Show>
        <Show when={readOnly}>
          <span class="adv-badge">RO</span>
        </Show>
        <span class="adv-comp__dot" aria-hidden="true" />
        <Show when={canResetParam(def) && paramDiverged(def)}>
          <button
            type="button"
            class="adv-card__reset"
            title={`Reset ${def.name}`}
            onClick={() => {
              resetParam(def)
            }}
          >
            ↺
          </button>
        </Show>
      </div>
      <span class="adv-comp__label">{def.label}</span>
    </div>
  )
}

/** One sibling array as an aligned plot row. */
const CompRow: Component<{ name: string }> = (props) => {
  const def = paramDef(props.name)
  if (def.kind === 'aobg_channel_major') {
    const rows = createMemo(() => channelRows(def))
    return (
      <Index
        each={rows()}
        fallback={
          <div class="adv-comp__row">
            <Gutter def={def} />
            <span class="adv-comp__empty">no channels configured</span>
          </div>
        }
      >
        {(row, index) => (
          <div class="adv-comp__row">
            <div class="adv-comp__chanhead">
              <Show when={index === 0}>
                <Gutter def={def} />
              </Show>
              <span class="adv-chans__id">ch {String(row().id)}</span>
            </div>
            <Bars seat={chanSeat(def, row)} />
          </div>
        )}
      </Index>
    )
  }
  return (
    <div class="adv-comp__row">
      <Gutter def={def} />
      {def.access === 'read_only_dynamic' ? (
        <DynPlot def={def} />
      ) : (
        <Bars seat={bandSeat(def)} />
      )}
    </div>
  )
}

const Composite: Component<{ axis: string; rows: readonly string[] }> = (
  props,
) => {
  const axisDef = paramDef(props.axis)
  const slots = (): readonly number[] =>
    Array.from({ length: effectiveCount(axisDef) }, (_slot, i) => i)
  const tick = (slot: number): string => {
    const hz = rawToDisplay(paramValues(axisDef)[slot] ?? 0, axisDef.frac_bits)
    return hz >= 1000
      ? `${String(Number((hz / 1000).toFixed(1)))}k`
      : String(Math.round(hz))
  }
  return (
    <div class="adv-comp">
      <For each={props.rows}>{(name) => <CompRow name={name} />}</For>
      <div class="adv-comp__row adv-comp__row--axis">
        <Gutter def={axisDef} />
        <div class="adv-comp__axis">
          <For each={slots()}>
            {(slot) => (
              <span
                class="adv-comp__tick"
                title={`${axisDef.name}[${String(slot + 1)}] = ${tick(slot)} Hz`}
              >
                {tick(slot)}
              </span>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

export default Composite
