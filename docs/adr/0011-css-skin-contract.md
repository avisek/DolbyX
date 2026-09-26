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

## Addendum (2026-09-26) — lessons from the main-screen prototype

Fourth instance — the main screen, prototyped as one skeleton under three
skins (branch `proto/main-screen`); the Dashboard skin became Classic.
What held, beyond the first addendum:

**A row is a `label`; the label serves both hit area and hover.** The
LAN Access row and each Master control are `label`s for their switch;
the power row's hit surface is the power label's stretched `::before`,
not the header. Where a surface has no padding of its own (the header,
the Advanced disclosure), the hover fill **bleeds**: the pseudo-element
takes a negative inset and the Shell's gutters stay at least that wide,
so content sits flush while the fill reaches into the gutter. Hover and
focus tint live on the same pseudo; hover stays under `:where()`.

**No layout wrappers in the skeleton.** A wrapper that groups controls
for one skin's convenience (the LAN "cluster") forces every skin into
that grouping — wrapping put the switch on the wrong line. Skins lay out
direct children; a wrapper exists only when it carries state or clips
its own fold.

**Popover open state is component state.** The component publishes the
modifier and owns focus: opening moves focus into the popover; Esc,
Enter, or focus leaving closes it and returns focus. The skin positions
it (anchor positioning, `--z-*` tokens for z-order) and may hide the
closed state with `display: none` under `transition-behavior:
allow-discrete` + `@starting-style` — the one place `display` is
allowed, because an absolutely positioned box that is merely invisible
still counts toward scrollable overflow. Ancestors between a popover
and the Shell must not take `filter` or `transform` (they would become
its containing block); the Off-look dims with `opacity` for that reason.

**Timed state stays component-side.** "Copied" is a 1.5 s modifier the
component raises and clears; the skin only decides what a copied button
looks like. Same line as Vis idle.

**Glyphs are tokens.** Buttons with icons render empty, named by
`aria-label` and `title`; the skin paints an SVG mask token
(`--icon-*`) with `currentColor`. Any text the skin wants to add is
pseudo-element content, as before.

**Fluid without viewport units.** No `vw`/`vh`/`svh`/`dvh` anywhere, not
even on `body` — `100%` height chains instead — and no viewport-width
media queries: wrapping (`flex-wrap`, `auto-fit`) first, container
queries where a region must reflow. Container thresholds are literals
(size queries cannot read tokens); every other length is a token.

**Identity-stable rendering is keyboard accessibility.** A radio group
re-rendered from a rebuilt array drops focus when its nodes are
recreated; positional keying (`Index`) keeps the focused node alive
across snapshots. Component-owned, like every keyboard rule.

**Fields size to their content.** The rename field renders in flow with
`field-sizing: content`, starting at the pill's width and growing as
typed — no absolute overlay, no measured widths.
