# Slice 16 — Event-driven visualizer

**Goal.** The UI shows the 20×48 SVG spectrum brick field driven by
per-block `vis` events from the main session. When audio stops, the client
freezes and fades on its own — no suspend protocol, no daemon pump.

**Blocked by:** Slices 05, 08, 09, 11 (09 Playwright harness + 11 audio
server gate only behavior 9; real-audio demo needs 13 or 21).
**Mode:** AFK.

## What to build

(ADR-0008 — `docs/adr/0008-visualizer-equalizer-rendering-spec.md`) The V/E
is DDP's most visible piece — it must feel identical to the original.
Reference screenshot:
`docs/ui-reference/original-ui-visualizer-eq-overlay.png`. Constants
transcribe from `decompiled/DsUI.apk/sources/com/dolby/ds1appUI/`.

### Feed — pure event stream (v1's 50 ms pump is dead)

- **Data**: the shim already appends `vnbg ‖ vnbe ‖ vcbg ‖ vcbe` to every
  `Process` reply (Slice 07). No `get_params`, no round-trip, no pump
  thread.
- **Broadcast** (new: vis fan-out in `EngineSupervisor`): one `vis` event
  per **main-session** block, all four arrays keyed by 4-CC, raw i16
  1/16-dB, to every WS client (no originator rule for `vis`). No
  coalescing, no timer: no audio → no events. Process-driven, not
  power-gated — bypassed blocks still emit; render what the engine
  yields.
- **Source stability**: main = oldest; the source never switches while
  the main session is merely silent — only when it dies (then next-oldest
  takes over; readouts re-read landed in Slice 11). Predictable, no
  flicker.
- **Render**: client draws every `rAF` (~60 fps) from the latest event
  with fast-attack / slow-decay per-band ballistics — smooth at any host
  block rate. `vc*` drives the spectrum (and, in Slice 17, the EQ curve);
  `vn*` feeds the Advanced panel's live cards (Slice 20).
- **Idle** (client-derived): no event for ~200 ms → freeze last frame,
  then fade spectrum to the floor over ~500 ms.

### SVG layer stack (`Visualizer.tsx`; z-order, last = top)

1. Background — radial gradient (dark navy → near-black) via CSS
   variables.
2. Grid — 1-px black `<line>`s between every column and row.
3. Spectrum bricks — 20 cols × 48 rows. Brick `(c, r)` filled iff
   `excitation_idx(c) ≥ 47 − r`; color `r < 12` red, `12 ≤ r < 18`
   yellow, `r ≥ 18` blue (`ROWS_RED = 12`, `ROWS_YELLOW = 6`,
   `GraphicVisualiserPainter.java`). Empty rows render the dark "off"
   tile.
4. Level pip — one brighter cyan brick per column at the row for the
   current `vcbg[c]` (per-column EQ indicator, same source as the curve).
5. EQ overlay group — placeholder `<g>` with a CSS `opacity` transition;
   contents (track/thumbs/curve) land in Slice 17.

**dB mapping**: `dB ∈ [−12, +36]` → 48 rows of 1 dB. **Asymmetric** —
matches the engine, not ±12. (The overlay's `thumbHeight/4` top+bottom
padding applies in Slice 17.)

**Frequency labels**: sourced at render time from the bootstrap metadata's
`gebf` entry — no hardcoded labels; a future engine with different band
edges adapts automatically.

## Behaviors to test

1. [ ] Every `process()` on the main session broadcasts one `vis` event
       carrying the reply's four arrays verbatim under 4-CC keys.
2. [ ] `process()` on a non-main session emits nothing.
3. [ ] No audio → no `vis` events; no timer fires; no suspend flag
       exists anywhere.
4. [ ] Main session dies → next-oldest becomes the source.
5. [ ] Ballistics: fast attack / slow decay per band; stable across
       block-rate changes (fabricated frame cadences).
6. [ ] Idle: ~200 ms silence → freeze; ~500 ms fade to floor.
7. [ ] 20×48 render; brick fill + color rule matches ADR-0008 (`r<12` /
       `12≤r<18` / `r≥18`); level pip at `vcbg[c]`.
8. [ ] dB mapping asymmetric `[−12, +36]`.
9. [ ] Playwright: with a synthetic plugin pushing a tone through the
       real engine, bricks move on screen.

## Tracer bullet

Start daemon with `StubBackend` fabricating fixed `VisFrame`s; keep the
main session live via periodic `process()` (no audio path needed);
subscribe via WS; assert one `vis` event per `process()` with the
fabricated arrays verbatim, and zero events after calls stop.

**Mock policy.** Stub fabricated frames for the fan-out + UI tests; the
real vis tail was verified in Slice 07; behavior 9 real.

## References

- ADR-0008 (`docs/adr/0008-visualizer-equalizer-rendering-spec.md`)
- Epic: wire protocol (`vis` event), invariants (main session)
- `docs/ddp/04-ui-data-flow.md` — the original
  pump being replaced
- Java reference: `GraphicVisualiser.java` (SurfaceView host + paint
  thread), `GraphicVisualiserPainter.java` (bricks, `convertValue`
  mapping)
- CONTEXT.md — "`vis` event", "Native grid", "`vcbg` / `vcbe`"
