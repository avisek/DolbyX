# CSS skin contract: components expose data, skins own appearance

DolbyX will ship alternative looks (**Skins** — CSS-only visual
variants of the whole UI) without touching component code. The
contract: a component renders semantic structure — regions, data
displays, and bare chrome surfaces for skins to paint — and publishes
*data*: continuous CSS custom properties in real units (e.g. dB
floats) plus state as BEM modifier classes (power is `app--off` on the
app root, so every component skins its off-look from one marker;
feature state sits on its owner — the visualizer mirrors resolved
`ven` as `visualizer--off`). **No
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
1 row / the wire's 1/16-dB quantum, an exact identity ⇒ observably
continuous), so derived skins retune by overriding two vars. A step
must stay numeric — `round()` can't consume a `none`, and an invalid
substitution voids the whole declaration; "no quantization" is spelled
"the data's own resolution".

Second instance — the GEQ editor's visibility (ADR-0008): the
component publishes one drag-state modifier (`visualizer--eq-drag`)
and zero timers; the reveal triggers (`:hover`, `:focus-within`, the
modifier), both fades, and the idle linger are skin CSS (asymmetric
`transition-delay`), so a skin can pick click-only reveal or an
always-visible editor without code changes. Contract consequence:
skins hide such interactive chrome with `opacity`, never `visibility`
or `display` — hidden elements must stay focusable, or keyboard users
could never trigger the focus reveal (and screen readers keep working
sliders regardless of visual state). Timed *state* (Vis idle's 250 ms)
stays component-side — it changes what the data *is*; timed
*appearance* (the linger, the descent) is the skin's.
Consequence: jsdom tests see only the var/class seam;
rendered-geometry truth needs a real browser (Playwright).

## Addendum (2026-09-20) — lessons from the Advanced panel prototype

Third instance — the Advanced panel, prototyped as one **skeleton**
under three skins (branch `proto/advanced-panel`). It held: no per-skin
TSX exists, and every look below is CSS only. What a skin author must
know:

**Layout is nested subgrid, never `display: contents`.** Sections keep
their boxes (aligned to the outer tracks through `subgrid`), so a fold
can animate and the accessibility tree keeps its regions; `contents`
removes the box, and with it both. Masonry (multicol today, native when
Chromium ships it), anchor positioning, `transform`, `z-index`, and
`@property` are skin-side tools — the component never reaches for them.

**Collapsed content is state; revealed chrome is appearance.** A fold
publishes `--collapsed`; the skin animates the body's track and may take
the content out of the tab order with a *delayed* `visibility`
transition once the fold lands. Hover- or focus-revealed chrome (the
first instance's rule) still hides with `opacity` only. Hover rules stay
below focus weight — wrap the hover selector in `:where()` — so a
focused control always wins the style contest.

**The component publishes; the skin reads.** Kind, access, and state
arrive as BEM modifiers (`--exp`, `--ro`, `--preset`, `--diverged`,
`--collapsed`, `--active`, `--editing`, `--live`, …), continuous data as
custom properties in real units (`--value`, `--norm` over `[min, max]`,
`--count`). Badges have no elements: a skin colour-codes the 4-CC by
access or synthesizes badge and icon text via pseudo-element `content`.
Screen readers and localization are deliberately out of scope; keyboard
accessibility is first-class and component-owned.

**State-carrying chrome is one real `button`.** The reset marker is a
button `disabled` while the value equals its baseline — focusable exactly
when it means something — and the skin morphs it from a resting dot into
↺ on hover or focus. No dot elements, no duplicate indicators.

**One skin entry point.** A single stylesheet imports every component's
BEM CSS; components import no CSS. The skin's vocabulary is a token
scale — spacing, `--control-h`, radius, access hues, fold timing, focus
ring — that components never read. Chromium is the v2.0 target:
subgrid, anchor positioning, `@property`, and `overflow: clip` are fair
game.
