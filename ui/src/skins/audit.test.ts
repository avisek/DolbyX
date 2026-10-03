/**
 * Slice 13 (#116): the Shell is fluid without viewport units (ADR-0011,
 * second addendum) — every skin stylesheet is audited as text. Comments
 * are stripped first: prose may name a unit, code may not. Structural
 * only: a skin's colours, lengths and layout are its own (switching
 * addendum).
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
})
