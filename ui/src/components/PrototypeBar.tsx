import { createSignal, onCleanup, onMount, type Component } from 'solid-js'

/**
 * PROTOTYPE (#129): the floating variant switcher. Dev only (App.tsx
 * gates on `import.meta.env.DEV`). ← → cycle variants (not while an
 * input has focus); the scheme buttons force light / dark / auto.
 * Writes `html[data-variant]` / `[data-scheme]` and the URL.
 */
export const VARIANTS = [
  ['a', 'Capsule · pills · stacked'],
  ['b', 'Matrix · inline collapse · one line'],
  ['c', 'Needle · menu · ghost strip'],
] as const

const html = () => document.documentElement

const PrototypeBar: Component = () => {
  const [variant, setVariant] = createSignal(html().dataset.variant ?? 'a')
  const [scheme, setScheme] = createSignal(html().dataset.scheme ?? '')

  const sync = () => {
    html().dataset.variant = variant()
    if (scheme()) html().dataset.scheme = scheme()
    else delete html().dataset.scheme
    const url = new URL(location.href)
    url.searchParams.set('variant', variant())
    if (scheme()) url.searchParams.set('scheme', scheme())
    else url.searchParams.delete('scheme')
    history.replaceState(null, '', url)
  }
  const cycle = (step: number) => {
    const i = VARIANTS.findIndex(([id]) => id === variant())
    const next = VARIANTS[(i + step + VARIANTS.length) % VARIANTS.length]
    if (next) setVariant(next[0])
    sync()
  }
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      const t = event.target
      if (
        t instanceof HTMLElement &&
        (t.matches('input, textarea, [contenteditable]') || t.isContentEditable)
      ) {
        return
      }
      if (event.key === 'ArrowLeft') cycle(-1)
      if (event.key === 'ArrowRight') cycle(1)
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  const label = () => VARIANTS.find(([id]) => id === variant())?.[1] ?? ''
  const btn =
    'border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 8px;border-radius:999px'
  const on = (active: boolean) =>
    `${btn};${active ? 'background:#fff;color:#000' : ''}`
  return (
    <div style="position:fixed;bottom:12px;left:50%;translate:-50%;z-index:9999;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:#111;color:#fff;font:13px/1.2 system-ui;box-shadow:0 4px 18px rgb(0 0 0 / 50%);border:1px solid #444;white-space:nowrap">
      <button type="button" style={btn} onClick={() => cycle(-1)}>
        ←
      </button>
      <b>{variant().toUpperCase()}</b>
      <span style="opacity:.8">{label()}</span>
      <button type="button" style={btn} onClick={() => cycle(1)}>
        →
      </button>
      <span style="width:1px;height:16px;background:#555" />
      {(['', 'light', 'dark'] as const).map((s) => (
        <button
          type="button"
          style={on(scheme() === s)}
          onClick={() => {
            setScheme(s)
            sync()
          }}
        >
          {s || 'auto'}
        </button>
      ))}
    </div>
  )
}

export default PrototypeBar
