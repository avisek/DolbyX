import { Show, type Component } from 'solid-js'
import { paramDef } from '../lib/parameters'
import { isWritable, writesToPreset } from '../store/wiring'
import WidgetFactory, { primaryControlId } from './WidgetFactory'

/**
 * One AK parameter's card (#85): a `label` for its primary control
 * (#86) — the whole card is the control's hit area — with flat
 * children the skin subgrids onto shared tracks. Zero appearance
 * policy: the skin reads the modifiers (ADR-0011); `title` is the
 * engine's description. Labels are category-relative, so the
 * accessible name of every control carries the category: "Volume
 * Leveler Amount".
 */
const ParamCard: Component<{ name: string; categoryLabel: string }> = (
  props,
) => {
  // Static per card: the table never changes within a page load.
  // eslint-disable-next-line solid/reactivity
  const def = paramDef(props.name)
  const name = () => `${props.categoryLabel} ${def.label}`
  return (
    <label
      class="adv-card"
      classList={{
        'adv-card--array': def.length > 1,
        'adv-card--ro': !isWritable(def),
        'adv-card--exp': def.access === 'experimental',
        'adv-card--preset': writesToPreset(def),
      }}
      for={primaryControlId(def)}
      title={def.description}
      // A native listener (not Solid's delegated one): the guard must
      // have run by the time the label's activation behavior asks
      // whether the click was cancelled.
      on:click={(event) => {
        // Only the card's own chrome forwards to the `for` target: a
        // click inside a control that manages its own focus (numeric
        // box, band strip — #87 on) keeps the focus it set. The Slider
        // cancels its own click (#89); tristate segments are nested
        // labels with their own radio forwarding — neither is listed.
        if (
          event.target instanceof Element &&
          event.target.closest('.adv-input, .adv-bands')
        ) {
          event.preventDefault()
        }
      }}
    >
      <code class="adv-card__code">{def.name}</code>
      <span class="adv-card__label">{def.label}</span>
      {/* The reset marker — read-only params have no Content key, so
          no marker; `disabled` until divergence lands (#92). */}
      <Show when={isWritable(def)}>
        <button
          type="button"
          class="adv-card__reset"
          disabled
          aria-label={`Reset ${name()}`}
        />
      </Show>
      <div class="adv-card__control">
        <WidgetFactory def={def} name={name()} />
      </div>
    </label>
  )
}

export default ParamCard
