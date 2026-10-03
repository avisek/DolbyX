/**
 * The active skin's `<style>` (ADR-0013): one element in `<head>`,
 * created on first call, holding the registered skin's text — an id the
 * registry doesn't ship paints the default. `main.tsx` calls this from
 * Bootstrap before the first render, so there is no flash and no second
 * request; the Shell's effect on `state.skin` calls it on every change
 * after that, and a change is a hard cut: swapping the text would fire
 * every `transition` the new sheet declares, so a suppressor `<style>`
 * covers the swap and leaves after a double `requestAnimationFrame`
 * (skeleton-owned; skins write no rule for it).
 */
import { findSkin } from '../skins'

/** Paints the skin registered under `id` (unknown → the default). */
export function applySkin(id: string): void {
  const { css } = findSkin(id)
  let style = document.getElementById('skin')
  if (!style) {
    // First paint — nothing on screen to transition.
    style = document.createElement('style')
    style.id = 'skin'
    style.textContent = css
    document.head.append(style)
    return
  }
  if (style.textContent === css) return
  const suppressor = document.createElement('style')
  suppressor.id = 'skin-swap'
  suppressor.textContent = '*,::before,::after{transition:none!important}'
  document.head.append(suppressor)
  style.textContent = css
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      suppressor.remove()
    })
  })
}
