/**
 * #136: `applySkin` paints one registered skin into the single
 * `<style id="skin">` — created on first call, reused after; an id the
 * registry doesn't ship paints the default (ADR-0013).
 */
import { beforeEach, expect, it } from 'vitest'
import { defaultSkin, findSkin, skins } from '../skins'
import { applySkin } from './skin'

const styleText = () => document.getElementById('skin')?.textContent

beforeEach(() => {
  document.getElementById('skin')?.remove()
})

it('bundles two distinct skins as text', () => {
  expect(skins.map(({ id }) => id)).toEqual(['remastered', 'classic'])
  for (const { css } of skins) expect(css.length).toBeGreaterThan(0)
  expect(findSkin('classic').css).not.toBe(findSkin('remastered').css)
})

it('writes the registered css into <style id="skin"> in <head>', () => {
  applySkin('classic')
  const style = document.head.querySelector('style#skin')
  expect(style?.textContent).toBe(findSkin('classic').css)
})

it('paints the default for an id the registry does not ship', () => {
  applySkin('nope')
  expect(styleText()).toBe(defaultSkin.css)
})

it('reuses the one element on a second call', () => {
  applySkin('classic')
  applySkin('remastered')
  expect(document.querySelectorAll('style#skin')).toHaveLength(1)
  expect(styleText()).toBe(findSkin('remastered').css)
})
