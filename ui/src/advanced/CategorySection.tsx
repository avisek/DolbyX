// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * One category as one semantic section — the SAME DOM in every skin:
 * header (the collapse toggle FIRST — a button that IS the header's
 * box, chevron / title / count inside it, no nested interactive
 * content — then the scoped reset that doubles as the divergence
 * marker, laid over the toggle's right end by the skin) + body
 * wrapper > param cards. Collapsed is a BEM modifier on
 * the section; the fold animation and the delayed `visibility:
 * hidden` that drops the body out of the tab order are skin CSS.
 * Expanded by default. `adv-cat--preset` marks a category whose live
 * truth sits on the selected EQ preset (the skin captions it);
 * divergence and reset follow that seat (wiring's `categorySeats`).
 */
import { For, createSignal, type Component } from 'solid-js'
import type { AdvancedCategory } from './categories'
import ParamCard from './ParamCard'
import { categoryDiverged, categoryOnPreset, resetCategory } from './wiring'

const CategorySection: Component<{ category: AdvancedCategory }> = (props) => {
  const [open, setOpen] = createSignal(true)
  const params = (): readonly string[] => props.category.params
  return (
    <section
      class="adv-cat"
      classList={{
        'adv-cat--collapsed': !open(),
        'adv-cat--diverged': categoryDiverged(params()),
        'adv-cat--preset': categoryOnPreset(params()),
      }}
      aria-label={props.category.label}
    >
      <header class="adv-cat__head">
        <button
          type="button"
          class="adv-cat__toggle"
          aria-expanded={open()}
          onClick={() => setOpen(!open())}
        >
          <span class="adv-cat__chevron" aria-hidden="true" />
          <span class="adv-cat__title">{props.category.label}</span>
          <span class="adv-cat__count">{String(params().length)}</span>
        </button>
        <button
          type="button"
          class="adv-cat__reset"
          disabled={!categoryDiverged(params())}
          aria-label={`Reset ${props.category.label}`}
          title={`Reset ${props.category.label}`}
          onClick={() => {
            resetCategory(params())
          }}
        />
      </header>
      <div class="adv-cat__body">
        <For each={params()}>
          {(name) => (
            <ParamCard name={name} categoryLabel={props.category.label} />
          )}
        </For>
      </div>
    </section>
  )
}

export default CategorySection
