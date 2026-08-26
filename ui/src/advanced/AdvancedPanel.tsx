// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The Advanced panel (Slice 20, #28) — ONE component tree for all
 * three skins: `?variant=` only swaps the `advanced--skin-a|b|c`
 * modifier on this root; every layout/appearance difference lives in
 * skin CSS (ADR-0011 stress test). Prototype defaults EXPANDED
 * (production: collapsed + localStorage).
 */
import { For, Show, createSignal, type Component } from 'solid-js'
import { CATEGORIES } from './categories'
import CategorySection from './CategorySection'
import Switcher from './Switcher'
import { variant } from './variant'
import './advanced.css'
import './skin-a.css'
import './skin-b.css'
import './skin-c.css'

const AdvancedPanel: Component = () => {
  const [open, setOpen] = createSignal(true)
  return (
    <section
      class={`advanced advanced--skin-${variant()}`}
      aria-label="Advanced"
    >
      <button
        type="button"
        class="advanced__header"
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
      >
        <span class="advanced__chevron" aria-hidden="true" />
        Advanced
      </button>
      <Show when={open()}>
        <div class="advanced__body">
          <For each={CATEGORIES}>
            {(category) => <CategorySection category={category} />}
          </For>
        </div>
      </Show>
      <Switcher />
    </section>
  )
}

export default AdvancedPanel
