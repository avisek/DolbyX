/**
 * Slice 13 (#116): the Shell is fluid without viewport units (ADR-0011,
 * second addendum) — every skin stylesheet is audited as text. Comments
 * are stripped first: prose may name a unit, code may not. Widened by
 * #94: outside the token file no literal colour and no `px` length but
 * the hairline — the last hardcoded values are named Classic tokens.
 */
import { describe, expect, it } from 'vitest'

const sheets = import.meta.glob<string>('./**/*.css', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Blank every comment, newlines kept, so offender lines stay real. */
const stripComments = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))

const THEME = './classic/theme.css'

/**
 * `path:line` of every line matching `pattern`, across the skin tree;
 * `outsideTheme` leaves the token file out — the one place a literal
 * value is the point.
 */
function offenders(pattern: RegExp, outsideTheme = false): string[] {
  return Object.entries(sheets)
    .filter(([path]) => !(outsideTheme && path === THEME))
    .flatMap(([path, css]) =>
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

  // Behavior 1: no viewport-width media query — wrapping first,
  // container queries where a region must reflow.
  it('uses no width media query', () => {
    expect(offenders(/@media[^{]*\b(min-|max-)?(width|inline-size)\b/)).toEqual(
      [],
    )
  })

  // Behavior 1: no `!important` — specificity is arranged, never forced.
  it('uses no !important', () => {
    expect(offenders(/!\s*important/)).toEqual([])
  })

  // Behavior 2: the Off-look is one Shell rule — no component sheet
  // reads `app--off` for itself.
  it('reads app--off only from the Shell rule', () => {
    const files = new Set(offenders(/app--off/).map((at) => at.split(':')[0]))
    expect([...files]).toEqual(['./classic/App.css'])
  })

  // #94 behavior 1: colours are tokens — no hex or functional colour
  // literal outside the theme file (a `#` id selector is not a colour).
  it('paints no literal colour outside the theme', () => {
    expect(
      offenders(
        /(^|[\s(,:])#[0-9a-f]{3,8}(?![\w-])|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i,
        true,
      ),
    ).toEqual([])
  })

  // #94 behavior 1: lengths are tokens — no `px` outside the theme file
  // but the hairline (`1px`, `-1px`) and a registered property's `0px`.
  it('uses no px length but the hairline outside the theme', () => {
    expect(offenders(/(?<![\w.])(?!-?[01]px\b)-?\d*\.?\d+px\b/, true)).toEqual(
      [],
    )
  })
})
