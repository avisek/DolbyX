/**
 * The Skin registry (ADR-0013): the UI's list of shipped skins — the
 * single source of truth for what can be chosen. Every Skin entry point
 * is bundled as text (`?inline`) so the single-file build carries all
 * of them and a switch swaps one `<style>`'s text live; the daemon
 * stores only the chosen id, unchecked. The only module that imports
 * CSS (the lint rule exempts it — src/skin.test.ts).
 */
import classic from './classic/index.css?inline'
import remastered from './remastered/index.css?inline'

export interface Skin {
  /** The id the daemon stores and the snapshot carries. */
  readonly id: string
  /** The Skin picker's pill text. */
  readonly label: string
  /** The entry point's processed text — every sheet, inlined assets. */
  readonly css: string
}

/** Every shipped skin, pill order; the first is the default. */
export const skins = [
  { id: 'remastered', label: 'Remastered', css: remastered },
  { id: 'classic', label: 'Classic', css: classic },
] as const satisfies readonly Skin[]

/** Remastered — what an id the UI doesn't ship paints. */
export const defaultSkin: Skin = skins[0]

/** The registered skin for `id`, or the default when none matches. */
export function findSkin(id: string): Skin {
  return skins.find((skin) => skin.id === id) ?? defaultSkin
}
