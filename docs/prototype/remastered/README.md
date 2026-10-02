# Remastered seed — prototype (#129)

Throwaway branch `prototype/remastered`. Run `just dev`, open
`http://localhost:9876/?variant=a` — the floating bar cycles variants
(← →) and forces light / dark. Screenshots here come from
`ui/e2e/prototype-remastered.spec.ts` (`pnpm exec playwright test prototype`).

| variant | visualizer | switcher | LAN + Skin region |
| --- | --- | --- | --- |
| a | Capsule: continuous rounded bars, glow, scheme-following field, guides at 0/12/24 dB, remastered EQ editor (hairline track, dot thumb, clean curve, no linger) | pills | stacked full-width rows |
| b | Matrix: 2-dB LED segments, ghost unlit, scheme-following field | checked pill, rest unfold inline on hover / focus | one line (two Shell tracks) |
| c | Needle: hairlines + dot pip, dotted guide, scheme-following field | select box; click opens, a pick closes, click-away closes (two CSS clocks, no JS) | ghost strip, hairline above |

Files: `<variant>-<scheme>-<width>.png` (full page), `-idle` (no feed:
pips / thumbs / curve aligned at 0 dB), `-eq` (editor over a feed),
`-switcher` (opened) / `-switcher-picked` (after a pick), `advanced-<scheme>.png`.
