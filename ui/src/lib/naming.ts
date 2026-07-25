/**
 * Display-name minting for the Add gestures (issue #26): the UI mints
 * labels, the daemon is indifferent — names are labels, ids are
 * identity, duplicates tolerated (ADR-0005). Minting only avoids them.
 */

/**
 * The clone label for `source`: base = the source name minus any
 * trailing ` <integer>`, then `«base» n` for the smallest n ≥ 2 not in
 * `taken` (every name of that kind).
 */
export function cloneName(source: string, taken: readonly string[]): string {
  return mint(source.replace(/ \d+$/, ''), 2, taken)
}

/**
 * The label for a None capture — the profile's own EQ params birthed
 * as a preset: `Preset n` for the smallest n ≥ 1 not in `taken`.
 */
export function captureName(taken: readonly string[]): string {
  return mint('Preset', 1, taken)
}

/** The smallest-`n` unused `«base» n`, counting up from `first`. */
function mint(base: string, first: number, taken: readonly string[]): string {
  const names = new Set(taken)
  let n = first
  while (names.has(`${base} ${String(n)}`)) n += 1
  return `${base} ${String(n)}`
}
