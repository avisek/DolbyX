# CSS skin contract: components expose data, skins own appearance

DolbyX will ship alternative looks (**Skins** — CSS-only visual
variants of the whole UI) without touching component code. The
contract: a component renders semantic structure — regions, data
displays, and bare chrome surfaces for skins to paint — and publishes
*data*: continuous CSS custom properties in real units (e.g. dB
floats) plus state as BEM modifier classes (power is `app--off` on the
app root, so every component skins its off-look from one marker). **No
appearance policy in TSX**: no colors, no thresholds, no quantization
— and no stacking policy: the component never sets z-index, transform,
opacity, or filter, so every element shares one stacking context and
z-order belongs entirely to the skin. v2.0 ships exactly one skin
(Classic, the faithful DDP look) and no switching mechanism — the
contract is the base, not the feature.

First instance — the visualizer (ADR-0008): per-band column elements
(count = the live `vcnb` param) carrying `--exc`/`--gain` as
continuous dB. The rejected shape was JS-computed appearance
(per-brick rects with the fill rule in TSX): it bakes quantization
into markup, so a smooth skin — or any different brick geometry —
would need code changes. Continuous vars + CSS `round(…, step)` keep
quantization a skin decision; by convention a skin holds its steps in
custom properties (visualizer: `--exc-step`, `--gain-step` — Classic:
1 row / none), so derived skins retune by overriding two vars.
Consequence: jsdom tests see only the var/class seam;
rendered-geometry truth needs a real browser (Playwright).
