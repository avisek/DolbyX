// PROTOTYPE — throwaway (Slice 20 spec exploration), do not review

/** The `?variant=` SKIN switch — reload-stable, replaceState on set.
 * The id only picks a modifier class on the panel root
 * (`advanced--skin-a|b|c`); the DOM is identical across skins. v4:
 * C is the default (absent / unknown `?variant` ⇒ c). */
import { createSignal } from 'solid-js'

export type VariantId = 'a' | 'b' | 'c'

export const VARIANTS: readonly { id: VariantId; label: string }[] = [
  { id: 'a', label: 'Skin A — flat card grid' },
  { id: 'b', label: 'Skin B — dense category cards' },
  { id: 'c', label: 'Skin C — roomy category cards (default)' },
]

function readUrl(): VariantId {
  const raw = new URLSearchParams(location.search).get('variant')
  return raw === 'a' || raw === 'b' ? raw : 'c'
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
  setVariant(VARIANTS[next]?.id ?? 'c')
}
