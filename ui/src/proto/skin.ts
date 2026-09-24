// PROTOTYPE — throwaway, do not review

/** Installs the three variant stylesheets as `<style>` elements after
 * the skin's own (so they override), and keeps exactly one enabled —
 * the `?variant` one. No `[data-variant]` prefixing: each file is a
 * complete main-screen skin. */
import { createEffect, createRoot } from 'solid-js'
import a from '../skins/classic/proto/a.css?inline'
import b from '../skins/classic/proto/b.css?inline'
import c from '../skins/classic/proto/c.css?inline'
import proto from './proto.css?inline'
import { variant, type VariantId } from './variant'

const SHEETS: Record<VariantId, string> = { a, b, c }

export function installProtoSkin(): void {
  const styles = new Map<VariantId, HTMLStyleElement>()
  for (const id of ['a', 'b', 'c'] as const) {
    const style = document.createElement('style')
    style.dataset['protoVariant'] = id
    style.textContent = SHEETS[id]
    style.disabled = true
    document.head.append(style)
    styles.set(id, style)
  }
  const chrome = document.createElement('style')
  chrome.textContent = proto
  document.head.append(chrome)
  createRoot(() => {
    createEffect(() => {
      const active = variant()
      for (const [id, style] of styles) style.disabled = id !== active
    })
  })
}
