import { Match, Switch, type Component } from 'solid-js'
import {
  onValue,
  unitLabel,
  type ParamAccess,
  type ParamKind,
  type ParameterDef,
} from '../lib/parameters'
import { rawToDisplay } from '../lib/units'
import { commitParam, isWritable, paramValues } from '../store/wiring'
import Toggle from './Toggle'
import Tristate, { tristateRadioId } from './Tristate'

/** A scalar card's raw head value. */
const head = (def: ParameterDef): number => paramValues(def)[0] ?? 0

/** The element id of a card's control. */
const controlId = (def: ParameterDef): string => `adv-${def.name}`

/**
 * The primary control a card labels — its `for` target: the switch,
 * the tristate's *currently checked* radio (so a label click focuses
 * the current state), none while the card is still a readout. Reactive
 * through the head value; mirrors the factory's dispatch.
 */
export function primaryControlId(def: ParameterDef): string | undefined {
  if (def.length > 1 || !isWritable(def)) return undefined
  const kind = kindTag(def.kind)
  if (kind === 'toggle') return controlId(def)
  if (kind === 'tristate') return tristateRadioId(controlId(def), head(def))
  return undefined
}

/**
 * The generic readout — a card's values as text, `frac_bits` applied,
 * the kind's unit appended. Every combo renders it in this slice
 * (#85); #86–#91 replace branches with the real widgets.
 */
const Readout: Component<{ def: ParameterDef; name: string }> = (props) => {
  const text = () => {
    const values = paramValues(props.def)
      .map((raw) => String(rawToDisplay(raw, props.def.frac_bits)))
      .join(', ')
    const unit = unitLabel(props.def.kind)
    return unit ? `${values} ${unit}` : values
  }
  return (
    <output class="adv-readout" aria-label={props.name}>
      {text()}
    </output>
  )
}

/** A kind's tag — the unit variant itself, a struct variant's key. */
function kindTag(kind: ParamKind): string {
  return typeof kind === 'string' ? kind : (Object.keys(kind)[0] ?? '')
}

const KNOWN_KINDS: ReadonlySet<string> = new Set<string>([
  'toggle',
  'integer',
  'frequency_hz',
  'degrees',
  'per_band',
  'aobg_channel_major',
  'opaque',
  'tristate',
  'decibel',
])

const KNOWN_ACCESS: ReadonlySet<string> = new Set<ParamAccess>([
  'settable',
  'experimental',
  'read_only_dynamic',
  'read_only_static',
])

/** The params already warned about — one warning each, per page load. */
const warned = new Set<string>()

/**
 * One widget per `(kind, access)` combo, metadata-driven — no
 * per-param code, no layout policy. `def` is static per card, so
 * setup-time dispatch is sound. `name` is the accessible name
 * ("<Category label> <label>"). A combo the factory doesn't know —
 * metadata grew before the UI did — falls back to the readout and
 * warns once, never throws (ADR-0004).
 */
const WidgetFactory: Component<{ def: ParameterDef; name: string }> = (
  props,
) => {
  // Static per card: the table never changes within a page load.
  // eslint-disable-next-line solid/reactivity
  const def = props.def
  const kind = kindTag(def.kind)
  if (!KNOWN_KINDS.has(kind) || !KNOWN_ACCESS.has(def.access)) {
    if (!warned.has(def.name)) {
      warned.add(def.name)
      console.warn(
        `advanced: no widget for \`${def.name}\` (kind ${kind}, access ${def.access}); showing a readout`,
      )
    }
  }
  // Kind decides structure, access gates editability; `def` is static,
  // so the branch is taken once. Every other combo is still the
  // readout — #87–#91 add matches here.
  const editableScalar = def.length === 1 && isWritable(def)
  return (
    <Switch fallback={<Readout def={def} name={props.name} />}>
      <Match when={editableScalar && kind === 'toggle'}>
        <Toggle
          id={controlId(def)}
          name={props.name}
          checked={head(def) !== 0}
          onToggle={(on) => {
            commitParam(def, [on ? onValue(def.kind) : 0])
          }}
        />
      </Match>
      <Match when={editableScalar && kind === 'tristate'}>
        <Tristate
          id={controlId(def)}
          name={props.name}
          value={head(def)}
          onSelect={(option) => {
            commitParam(def, [option])
          }}
        />
      </Match>
    </Switch>
  )
}

export default WidgetFactory
