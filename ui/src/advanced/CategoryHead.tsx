// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/**
 * The shared category header — label as-is (no uppercase transform),
 * divergence dot over the category's profile-path writable params, and
 * a scoped reset (`resetProfile(id, ccs)`; see wiring's `categoryCcs`
 * for the preset-shadowing edge). Variant A renders it as a grid
 * divider; B/C as the category card's header.
 */
import { Show, type Component } from 'solid-js'
import type { AdvancedCategory } from './categories'
import { categoryDiverged, resetCategory } from './wiring'

const CategoryHead: Component<{ category: AdvancedCategory }> = (props) => (
  <div
    class="adv-cathead"
    classList={{
      'adv-cathead--diverged': categoryDiverged(props.category.params),
    }}
  >
    <span class="adv-cathead__label">{props.category.label}</span>
    <span class="adv-cathead__dot" aria-hidden="true" />
    <Show when={categoryDiverged(props.category.params)}>
      <button
        type="button"
        class="adv-cathead__reset"
        title={`Reset ${props.category.label}`}
        onClick={() => {
          resetCategory(props.category.params)
        }}
      >
        ↺ reset
      </button>
    </Show>
  </div>
)

export default CategoryHead
