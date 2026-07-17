# CSS skin contract: components expose data, skins own appearance

DolbyX will ship alternative looks (**Skins** — CSS-only visual
variants) without touching component code. The contract: a component
renders semantic structure and publishes *data* — continuous CSS
custom properties in real units (e.g. dB floats) plus state as
`data-*` attributes — and **no appearance policy**: no colors, no
thresholds, no quantization, no z-order in TSX. All of that lives in
the active skin's stylesheet. v2.0 ships exactly one skin (Classic,
the faithful DDP look) and no switching mechanism — the contract is
the base, not the feature.

First instance — the visualizer (ADR-0008): 20 column elements
carrying `--exc`/`--gain` as continuous dB, `data-power` on the root.
The rejected shape was JS-computed appearance (per-brick rects with
the fill rule in TSX): it bakes quantization into markup, so a smooth
skin — or any different brick geometry — would need code changes.
Continuous vars + CSS `round(…, step)` keep quantization a skin
decision; by convention a skin holds its steps in custom properties
(visualizer: `--exc-step`, `--gain-step` — Classic: 1 row / none), so
derived skins retune by overriding two vars. Consequence: jsdom tests
see only the var/attribute seam; rendered-geometry truth needs a real
browser (Playwright).
