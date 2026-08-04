// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** Variant B — category accordions: collapsible sections (first three
 * open), sticky headers with param counts, denser inner grid. */
import { For, Show, createSignal, type Component } from 'solid-js'
import { CATEGORIES } from './categories'
import ParamCard from './ParamCard'

const VariantB: Component = () => {
  const [openSet, setOpenSet] = createSignal<ReadonlySet<string>>(
    new Set(CATEGORIES.slice(0, 3).map((category) => category.name)),
  )
  const toggle = (name: string): void => {
    const next = new Set(openSet())
    if (!next.delete(name)) next.add(name)
    setOpenSet(next)
  }
  return (
    <div class="adv-acc">
      <For each={CATEGORIES}>
        {(category) => (
          <section class="adv-acc__section">
            <button
              type="button"
              class="adv-acc__header"
              aria-expanded={openSet().has(category.name)}
              onClick={() => {
                toggle(category.name)
              }}
            >
              <span class="adv-acc__chevron" aria-hidden="true">
                {openSet().has(category.name) ? '▾' : '▸'}
              </span>
              {category.label}
              <span class="adv-acc__count">{category.params.length}</span>
            </button>
            <Show when={openSet().has(category.name)}>
              <div class="adv-acc__grid">
                <For each={category.params}>
                  {(name) => <ParamCard name={name} />}
                </For>
              </div>
            </Show>
          </section>
        )}
      </For>
    </div>
  )
}

export default VariantB
