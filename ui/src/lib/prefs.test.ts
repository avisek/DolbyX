import { afterEach, expect, it } from 'vitest'
import { smootherKernel, visibleSliderCount } from './prefs'

afterEach(() => {
  localStorage.clear()
})

// Issue #25 part B: visible slider count — default 5 (the original
// mobile layout), clamped into [2, genb], junk falls back.
it('defaults the visible slider count to 5 and clamps into [2, genb]', () => {
  expect(visibleSliderCount(20)).toBe(5)

  localStorage.setItem('dolbyx.geq.sliders', '20')
  expect(visibleSliderCount(20)).toBe(20) // the original tablet layout

  localStorage.setItem('dolbyx.geq.sliders', '1')
  expect(visibleSliderCount(20)).toBe(2)
  localStorage.setItem('dolbyx.geq.sliders', '99')
  expect(visibleSliderCount(20)).toBe(20)

  localStorage.setItem('dolbyx.geq.sliders', '7')
  expect(visibleSliderCount(3)).toBe(3) // genb caps the pref

  for (const junk of ['', 'five', '4.5', '-3']) {
    localStorage.setItem('dolbyx.geq.sliders', junk)
    expect(visibleSliderCount(20)).toBe(5)
  }
})

// A genb below the [2, genb] floor (Advanced divergence, unsupported
// but must not crash): the count degrades to genb itself.
it('degrades the count to genb when genb sits below the 2-slider floor', () => {
  expect(visibleSliderCount(1)).toBe(1)
})

// The smoother kernel pref — default Mobile; only declared kernel
// names pass (part C consumes the selection).
it('defaults the smoother kernel to Mobile and rejects unknown names', () => {
  expect(smootherKernel()).toBe('Mobile')

  localStorage.setItem('dolbyx.geq.kernel', 'Soft')
  expect(smootherKernel()).toBe('Soft')
  localStorage.setItem('dolbyx.geq.kernel', 'Direct')
  expect(smootherKernel()).toBe('Direct')

  localStorage.setItem('dolbyx.geq.kernel', 'mobile')
  expect(smootherKernel()).toBe('Mobile')
})
