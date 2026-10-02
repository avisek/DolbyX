# Remastered seed — prototype (#129)

Throwaway branch `prototype/remastered`. Run `just dev`, open
`http://localhost:9876/?variant=a` — the floating bar cycles variants
(← →) and forces light / dark. Screenshots here come from
`ui/e2e/prototype-remastered.spec.ts` (`pnpm exec playwright test prototype`).

| variant | visualizer | switcher | LAN + Skin region |
| --- | --- | --- | --- |
| a | Capsule: continuous rounded bars, glow, dark field in both schemes | pills | stacked full-width rows |
| b | Matrix: 2-dB LED segments, ghost unlit, scheme-following field | checked pill, rest unfold inline on hover / focus | one line (two Shell tracks) |
| c | Needle: hairlines + dot pip, dotted guide, scheme-following field | select box, menu drops down on hover / focus | ghost strip, hairline above |

Files: `<variant>-<scheme>-<width>.png` (full page), `-eq` (editor
revealed), `-switcher` (menu revealed), `advanced-<scheme>.png`.
