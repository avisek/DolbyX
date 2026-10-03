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

const shoot = async (
  page: Page,
  name: string,
  clip?: Clip,
  animations: 'disabled' | 'allow' = 'disabled',
) => {
  await page.screenshot({
    path: join(OUT, `${name}.png`),
    mask: [page.getByRole('textbox', { name: 'LAN URL' })],
    maskColor: await tokenColor(page, '--color-bg'),
    fullPage: !clip,
    ...(clip ? { clip } : {}),
    animations,
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

    // Idle first: no feed, so pips / thumbs / curve all sit at 0 dB —
    // the alignment shot.
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme })
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto(`/?variant=${variant}`)
      await expect(page.getByRole('status')).toHaveText('Connected')
      const vis = await page.locator('.visualizer').boundingBox()
      if (vis) {
        await page.mouse.move(vis.x + vis.width / 2, vis.y + vis.height / 2)
        await page.waitForTimeout(400)
        await shoot(page, `${variant}-${scheme}-idle`, vis)
      }
    }

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
      // Hover one EQ thumb (the third slider) for the hover look.
      const thumb = page
        .locator('.eq-slider')
        .nth(2)
        .locator('.eq-slider__thumb')
      await thumb.hover()
      await page.waitForTimeout(300)
      await shoot(
        page,
        `${variant}-${scheme}-eq-hover`,
        vis ?? undefined,
        'allow',
      )
      // The switcher: hover (b) or click the box (c) opens it; then a
      // pick, which closes c.
      const picker = page.locator('.picker--skin')
      await picker.locator('.picker__radio:checked + .picker__option').click()
      await page.waitForTimeout(300)
      const box = await picker.boundingBox()
      const clip = box
        ? {
            x: box.x - 8,
            y: box.y - 8,
            width: box.width + 16,
            height: box.height + 260,
          }
        : undefined
      await shoot(page, `${variant}-${scheme}-switcher`, clip, 'allow')
      // c lays the radio over its label while open: that is the hit
      // target there; b's radio is a 1-px hidden box, the label is.
      await picker
        .locator(
          variant === 'c'
            ? '#picker-skin-paper'
            : 'label[for="picker-skin-paper"]',
        )
        .click()
      await page.waitForTimeout(300)
      await shoot(page, `${variant}-${scheme}-switcher-picked`, clip, 'allow')
      // Reopen with a late pick: c slides the list up, the box stays.
      await picker.locator('.picker__radio:checked + .picker__option').click()
      await page.waitForTimeout(300)
      await shoot(
        page,
        `${variant}-${scheme}-switcher-reopened`,
        clip
          ? { ...clip, y: clip.y - 160, height: clip.height + 160 }
          : undefined,
        'allow',
      )
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
