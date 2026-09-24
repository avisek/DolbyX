// PROTOTYPE — throwaway, do not review

/** The `?variant=` SKIN switch — reload-stable, replaceState on set.
 * The id enables exactly one of three CSS files (skin.ts); the DOM is
 * identical across skins. B is the default (absent / unknown ⇒ b). */
import { createSignal } from 'solid-js'

export type VariantId = 'a' | 'b' | 'c'

export const VARIANTS: readonly { id: VariantId; label: string }[] = [
  { id: 'a', label: 'Skin A — Stack' },
  { id: 'b', label: 'Skin B — Dashboard (default)' },
  { id: 'c', label: 'Skin C — Console' },
]

function readUrl(): VariantId {
  const raw = new URLSearchParams(location.search).get('variant')
  return raw === 'a' || raw === 'c' ? raw : 'b'
}

const [variant, setSignal] = createSignal<VariantId>(readUrl())

export { variant }

export function variantLabel(): string {
  return VARIANTS.find((entry) => entry.id === variant())?.label ?? ''
}

export function setVariant(id: VariantId): void {
  setSignal(id)
  const url = new URL(location.href)
  url.searchParams.set('variant', id)
  history.replaceState(null, '', url)
}

export function cycleVariant(delta: 1 | -1): void {
  const index = VARIANTS.findIndex((entry) => entry.id === variant())
  const next = (index + delta + VARIANTS.length) % VARIANTS.length
  setVariant(VARIANTS[next]?.id ?? 'b')
}
