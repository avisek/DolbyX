/**
 * Slice 02 (#84): the Classic skin entry point — real browser, real
 * daemon. Moving every stylesheet under one skin must be invisible on
 * screen, and the token scale must be live on the document root.
 */
import { expect, test } from './fixtures'

/**
 * Behavior 4's fixture: computed properties of the app root, the power
 * toggle, and a master-control slider, captured on `main` before the
 * move — skin-owned values only, nothing viewport-derived. Any drift
 * here means a stylesheet was lost, reordered, or edited. `.app` was
 * re-pinned by the Shell (#116): `place-content` / `gap` gone; the power
 * toggle by the header (#117): the shared switch scoped to `--power-h`.
 */
const BASELINE = {
  '.app': {
    display: 'grid',
    color: 'rgb(232, 238, 245)',
    'font-family': 'system-ui, "Segoe UI", Roboto, sans-serif',
  },
  '.power': {
    display: 'flex',
    gap: '12px',
    cursor: 'pointer',
  },
  '.power .adv-toggle': {
    width: '58.7969px',
    height: '33.5938px',
    'background-color': 'rgb(0, 180, 255)',
    'border-radius': '999px',
  },
  '.master-control': {
    padding: '12px 20px',
    'border-radius': '8px',
    'background-color': 'rgb(22, 34, 47)',
    gap: '8px',
  },
  '.master-control__slider': {
    'accent-color': 'rgb(0, 180, 255)',
    'flex-grow': '1',
    height: '16px',
  },
}

// Behavior 4: the app looks identical after the move.
test('computed styles match the pre-move baseline', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('status')).toHaveText('Connected')

  const actual = await page.evaluate((baseline) => {
    const out: Record<string, Record<string, string>> = {}
    for (const [selector, props] of Object.entries(baseline)) {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`${selector} not rendered`)
      const style = getComputedStyle(el)
      out[selector] = Object.fromEntries(
        Object.keys(props).map((prop) => [prop, style.getPropertyValue(prop)]),
      )
    }
    return out
  }, BASELINE)

  expect(actual).toEqual(BASELINE)
})

// Behavior 5: the token scale resolves on the document root — the
// spec's literals, incl. the `--space-3` issue #28 referenced before it
// existed.
test('the token scale resolves on the document root', async ({ page }) => {
  await page.goto('/')
  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const read = (name: string) => root.getPropertyValue(name).trim()
    return {
      controlH: read('--control-h'),
      space3: read('--space-3'),
      hueExperimental: read('--hue-experimental'),
    }
  })
  expect(tokens.controlH).not.toBe('')
  expect(tokens.space3).not.toBe('')
  expect(tokens.hueExperimental).not.toBe('')
})
