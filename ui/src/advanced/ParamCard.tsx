// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One parameter's card — a LABEL for its primary control (`for` =
 * the numeric field / the switch / the currently checked radio / the
 * first writable band; none for read-only arrays), so the whole card
 * is the control's hit area and forwards hover. Clicks that land IN a
 * custom control are not forwarded (see `onClick`): they keep the
 * focus they set. Flat children — code,
 * short label, reset, control region — so a skin can subgrid them
 * onto shared tracks. Zero appearance policy: access and seat are BEM
 * modifiers (`--exp`, `--ro`, `--preset`, `--diverged`, `--array`) the
 * skin colors / captions; the reset button IS the divergence marker
 * (always rendered, `disabled` when clean). `title` = the engine's
 * description.
 */
import type { Component } from 'solid-js'
import { paramDef } from '../lib/parameters'
import WidgetFactory, { primaryControlId } from './WidgetFactory'
import { isWritable, paramDiverged, resetParam, writesToPreset } from './wiring'

const ParamCard: Component<{ name: string; categoryLabel: string }> = (
  props,
) => {
  const def = paramDef(props.name)
  // Labels are category-relative ("Enable"); accessible names carry
  // the category so screen readers hear "Volume Leveler Enable".
  const name = `${props.categoryLabel} ${def.label}`
  return (
    <label
      class="adv-card"
      classList={{
        'adv-card--array': def.length > 1,
        'adv-card--ro': !isWritable(def),
        'adv-card--exp': def.access === 'experimental',
        'adv-card--diverged': paramDiverged(def),
        'adv-card--preset': writesToPreset(def),
      }}
      for={primaryControlId(def)}
      title={def.description}
      onClick={(event) => {
        // Only the card's own chrome forwards. Pointer capture
        // retargets a box's click to its wrapper span, and the slider
        // / strip are divs — none "interactive content", so the label
        // would forward them to its `for` target (a band card's: band
        // 1, yanking focus off the band just clicked).
        const target = event.target
        if (
          target instanceof Element &&
          target.closest('.adv-input, [role=slider], .adv-bands') !== null
        ) {
          event.preventDefault()
        }
      }}
    >
      <code class="adv-card__code">{def.name}</code>
      <span class="adv-card__label">{def.label}</span>
      <button
        type="button"
        class="adv-card__reset"
        disabled={!(isWritable(def) && paramDiverged(def))}
        aria-label={`Reset ${name}`}
        title={`Reset ${name}`}
        onClick={() => {
          resetParam(def)
        }}
      />
      <div class="adv-card__control">
        <WidgetFactory def={def} name={name} />
      </div>
    </label>
  )
}

export default ParamCard
