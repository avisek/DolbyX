// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** Variant A — flat grid: one continuous auto-fill grid, category
 * headers as full-width dividers. */
import { For, type Component } from 'solid-js'
import { CATEGORIES } from './categories'
import ParamCard from './ParamCard'

const VariantA: Component = () => (
  <div class="adv-flat">
    <For each={CATEGORIES}>
      {(category) => (
        <>
          <h3 class="adv-flat__divider">{category.label}</h3>
          <For each={category.params}>
            {(name) => <ParamCard name={name} />}
          </For>
        </>
      )}
    </For>
  </div>
)

export default VariantA
