/**
 * Structural audits over every skin stylesheet as text (ADR-0011,
 * switching addendum): no viewport unit (#116), `color-scheme` declared,
 * the default skin pinned to `defaults.toml` (#136). Comments are
 * stripped first: prose may name a unit, code may not. A skin's colours,
 * lengths and layout are its own — never audited.
 */
import { parse } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import defaultsToml from '../../../crates/ddp-daemon/defaults.toml?raw'
import { defaultSkin } from './index'

const sheets = import.meta.glob<string>('./**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Blank every comment, newlines kept, so offender lines stay real. */
const stripComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))

/** `path:line` of every line matching `pattern`, across the skin tree. */
function offenders(pattern: RegExp): string[] {
  return Object.entries(sheets).flatMap(([path, css]) =>
    stripComments(css)
      .split('\n')
      .flatMap((line, i) =>
        pattern.test(line) ? [`${path}:${String(i + 1)}`] : [],
      ),
  )
}

describe('the skin tree', () => {
  it('holds stylesheets', () => {
    expect(Object.keys(sheets).length).toBeGreaterThan(0)
  })

  // Behavior 1: no viewport unit — `100%` height chains and container
  // queries instead. `cqw`/`cqh` (container units) stay legal.
  it('uses no viewport unit', () => {
    expect(
      offenders(/\d(vw|vh|svw|svh|lvw|lvh|dvw|dvh|vmin|vmax|vi|vb)\b/),
    ).toEqual([])
  })
})

// #136: every skin declares its Colour scheme on `:root` — mandatory,
// not stylistic: the build lowers `light-dark()` only where the sheet
// declares a scheme (ADR-0011, switching addendum).
describe('each skin', () => {
  /** `./<dir>/…` → `<dir>`. */
  const skinOf = (path: string) => path.split('/')[1] ?? ''
  const dirs = [...new Set(Object.keys(sheets).map(skinOf))].sort()

  it.each(dirs)('%s declares color-scheme on :root', (dir) => {
    const css = Object.entries(sheets)
      .filter(([path]) => skinOf(path) === dir)
      .map(([, text]) => stripComments(text))
      .join('\n')
    expect(css).toMatch(/:root\s*\{[^}]*\bcolor-scheme\s*:/)
  })
})

// The default skin has one source: the daemon's `defaults.toml` ships
// the id, and the registry's first row must be it (ADR-0013).
describe('the default skin', () => {
  it('is the id defaults.toml ships', () => {
    const { skin } = parse(defaultsToml) as { skin: string }
    expect(defaultSkin.id).toBe(skin)
  })
})
