import { For, Show, createSignal, type Component } from 'solid-js'
import { categories } from '../lib/parameters'
import { advancedOpen, setAdvancedOpen } from '../lib/prefs'
import CategorySection from './CategorySection'

/**
 * The Advanced panel (#85): a disclosure at the bottom of the app over
 * every AK parameter, grouped into Parameter categories in bootstrap
 * order — nothing hand-listed (ADR-0004). Collapsed by default; the
 * body is unmounted while collapsed so the everyday UI pays nothing,
 * and `advanced--collapsed` is the skin's marker (ADR-0011). The open
 * state is a browser pref (`dolbyx.advanced.open`).
 */
const AdvancedPanel: Component = () => {
  const [open, setOpen] = createSignal(advancedOpen())
  const toggle = () => {
    setOpen(!open())
    setAdvancedOpen(open())
  }
  return (
    <section
      class="advanced"
      classList={{ 'advanced--collapsed': !open() }}
      aria-label="Advanced"
    >
      <button
        type="button"
        class="advanced__header"
        aria-expanded={open()}
        onClick={toggle}
      >
        <span class="advanced__chevron" aria-hidden="true" />
        Advanced
      </button>
      <Show when={open()}>
        <div class="advanced__body">
          <For each={categories()}>
            {(category) => <CategorySection category={category} />}
          </For>
        </div>
      </Show>
    </section>
  )
}

export default AdvancedPanel
