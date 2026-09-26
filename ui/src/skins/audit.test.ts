/**
 * Slice 13 (#116): the Shell is fluid without viewport units (ADR-0011,
 * second addendum) — every skin stylesheet is audited as text. Comments
 * are stripped first: prose may name a unit, code may not.
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
})
