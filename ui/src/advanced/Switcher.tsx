// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** The variant switcher — fixed bottom-center pill, deliberately
 * obviously-not-part-of-the-design. ← / → buttons + keyboard arrows
 * (skipped while an input / textarea / select / contenteditable /
 * ARIA slider / band strip is focused — those own their arrows). */
import { onCleanup, onMount, type Component } from 'solid-js'
import { cycleVariant, variantLabel } from './variant'

const Switcher: Component = () => {
  onMount(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable ||
          target.getAttribute('role') === 'slider' ||
          target.classList.contains('adv-bands__strip'))
      ) {
        return
      }
      cycleVariant(event.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => {
      window.removeEventListener('keydown', onKey)
    })
  })
  return (
    <div class="proto-switcher">
      <button
        type="button"
        class="proto-switcher__arrow"
        aria-label="Previous variant"
        onClick={() => {
          cycleVariant(-1)
        }}
      >
        ←
      </button>
      <span class="proto-switcher__label">{variantLabel()}</span>
      <button
        type="button"
        class="proto-switcher__arrow"
        aria-label="Next variant"
        onClick={() => {
          cycleVariant(1)
        }}
      >
        →
      </button>
    </div>
  )
}

export default Switcher
