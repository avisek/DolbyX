/**
 * The active skin's `<style>` (ADR-0013): one element in `<head>`,
 * created on first call, holding the registered skin's text — an id the
 * registry doesn't ship paints the default. `main.tsx` calls this from
 * Bootstrap before the first render, so there is no flash and no second
 * request.
 */
import { findSkin } from '../skins'

/** Paints the skin registered under `id` (unknown → the default). */
export function applySkin(id: string): void {
  let style = document.getElementById('skin')
  if (!style) {
    style = document.createElement('style')
    style.id = 'skin'
    document.head.append(style)
  }
  style.textContent = findSkin(id).css
}
