/**
 * PROTOTYPE (#129): screenshots of every variant in both schemes at
 * 1280 / 390, with a noise feed lighting the visualizer, LAN on. Not a
 * test — a camera. Output: docs/prototype/remastered/*.png.
 */
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import {
  expandAdvanced,
  expect,
  flipLan,
  foldSettled,
  test,
  tokenColor,
} from './fixtures'
import { SyntheticPlugin } from './plugin'

const OUT = join(import.meta.dirname, '../../docs/prototype/remastered')
const VARIANTS = ['a', 'b', 'c'] as const
const SCHEMES = ['dark', 'light'] as const

type Clip = { x: number; y: number; width: number; height: number }

const shoot = async (page: Page, name: string, clip?: Clip) => {
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    mask: [page.getByRole('textbox', { name: 'LAN URL' })],
    maskColor: await tokenColor(page, '--color-bg'),
    fullPage: !clip,
    ...(clip ? { clip } : {}),
    animations: 'disabled',
    caret: 'hide',
  })
}

const maxFill = (page: Page) =>
  page
    .locator('.vis-column__fill')
    .evaluateAll((fills) =>
      Math.max(...fills.map((el) => el.getBoundingClientRect().height)),
    )

for (const variant of VARIANTS) {
  test(`shoot variant ${variant}`, async ({ page, daemon }) => {
    test.setTimeout(240_000)
    const plugin = await SyntheticPlugin.connect(daemon.socketPath)
    await plugin.hello(48_000, 512)
    const FRAMES = 256
    let feeding = true
    const feed = (async () => {
      while (feeding) {
        const pcm = new Int16Array(FRAMES * 2)
        for (let i = 0; i < pcm.length; i += 1) {
          pcm[i] = Math.round((Math.random() * 2 - 1) * 16_000)
        }
        await plugin.process(pcm)
      }
    })()

    const lanOn = async () => {
      const lan = page.getByRole('switch', { name: 'LAN access' })
      if (!(await lan.isChecked())) await flipLan(page, true)
      await foldSettled(page)
    }
    const open = async (width: number) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/?variant=${variant}`)
      await expect(page.getByRole('status')).toHaveText('Connected')
      await expect
        .poll(() => maxFill(page), { timeout: 60_000 })
        .toBeGreaterThan(0)
    }

    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const width of [1280, 390]) {
        await open(width)
        await lanOn()
        await page.mouse.move(0, 0)
        await shoot(page, `${variant}-${scheme}-${String(width)}`)
      }
      // 1280 extras: EQ editor revealed; switcher revealed; Advanced
      // panel open (the palette over cards — same for every variant,
      // shot once).
      await open(1280)
      await lanOn()
      const vis = await page.locator('.visualizer').boundingBox()
      if (vis)
        await page.mouse.move(vis.x + vis.width / 2, vis.y + vis.height / 2)
      await page.waitForTimeout(400)
      await shoot(page, `${variant}-${scheme}-eq`, vis ?? undefined)
      const picker = page.locator('.picker--skin')
      await picker.hover()
      await page.waitForTimeout(300)
      const box = await picker.boundingBox()
      if (box) {
        await shoot(page, `${variant}-${scheme}-switcher`, {
          x: box.x - 8,
          y: box.y - 8,
          width: box.width + 16,
          height: box.height + 120,
        })
      }
      if (variant === 'a') {
        await expandAdvanced(page)
        await page.waitForTimeout(400)
        await page.mouse.move(0, 0)
        await shoot(page, `advanced-${scheme}`)
      }
    }
    feeding = false
    await feed
    plugin.goodbye()
  })
}
