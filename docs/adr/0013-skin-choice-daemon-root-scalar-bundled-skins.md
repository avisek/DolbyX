# Skin choice: a daemon root scalar, opaque; every skin bundled, swapped as text

The chosen skin is a root scalar `skin` resolved through the Cascade
like `lan_access` ([ADR-0007](0007-toml-overlay-persistence-with-file-watcher.md),
[ADR-0012](0012-lan-access-opt-in-app-owned-gate-no-auth.md)):
`defaults.toml` ships `"remastered"`, `config.toml` overrides, `set_skin`
writes it, every snapshot carries it, a hand-edit fans out like any
mutation. This deviates from the rule that UI display prefs (panel open,
folds) live in `localStorage`: a skin is the look of the *product*, not
of one browser — the phone on the LAN must paint the same skin as the
desktop, and only the daemon can fan that out. The daemon stores an
**opaque string** and validates nothing (`set_skin` never fails): the
**Skin registry** lives in the UI, the only place that knows which skins
exist, and an unknown id paints the default with no pill checked, so a
`config.toml` naming a skin a newer or older UI doesn't ship degrades
rather than refuses to start.

Every skin ships inside the single-file `index.html`: each Skin entry
point is imported as a string (`?inline`), one `<style>` holds the
active skin's text, and a switch replaces that text live — first paint
reads `skin` from Bootstrap before render, so there is no flash and no
second request. Swapping text fires every `transition` the new sheet
declares, so the swap suppresses transitions for one frame (hard cut).
Skin assets (fonts, images, SVG) are relative `url()`s in the skin's
directory, inlined as data URIs by the single-file build; a serve-mode
Vite plugin inlines them the same way in dev so dev and prod never
diverge and the daemon serves exactly two routes. Rejected: a
`localStorage` pref (no fan-out), a `?skin=` URL override (a second
source of truth), per-skin CSS files served by the daemon (a third
route, a flash, and a dev-origin story), daemon-side validation (a
`SKIN_UNKNOWN` error for a value the daemon cannot judge).
