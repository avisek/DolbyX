# DolbyX VST UI — Design & Implementation Plan

## Design Reference

The UI is inspired by the Android DDP app with enhancements for desktop.
See screenshots in the project for the original app UI.

## UI Layout (700 × 520 pixels)

Two-page design matching the Android app:

### Page 1: Profile Selector
- Power toggle + Dolby branding header
- Animated frequency bar visualizer (background)
- 6 profile cards in 3×2 grid: Movie, Music, Game, Voice, Custom 1, Custom 2
- Active profile highlighted with cyan border
- Clicking a profile navigates to Page 2

### Page 2: Profile Editor (main view)
- Header: profile name (clickable → Page 1) + Reset button
- Visualizer with real-time frequency bars (20 bands)
  - EQ curve overlay with 5 draggable knobs (when in Manual mode)
  - IEQ target curve display (when in preset mode)
- Three toggles with amount sliders:
  - Volume Leveler: ON/OFF + amount (0-10)
  - Dialogue Enhancer: ON/OFF + amount (0-16)
  - Surround Virtualizer: ON/OFF + boost (0-192, step 6)
- Intelligent EQ mode selector: Open, Rich, Focused, Manual
- Collapsible "Advanced" section:
  - Pre-gain slider (-12 to 0 dB)
  - Post-gain slider (0 to +12 dB)
  - Peak Limiter mode dropdown (Auto/Regulated/Disabled)
  - Volume Maximizer boost (0-192)
  - Next Gen Surround ON/OFF/AUTO
  - Audio Optimizer ON/OFF/AUTO
  - Dialog Enhancement ducking (0-16)
  - Headphone reverb gain
  - Volume Modeler ON/OFF
- "All Parameters" expandable panel for raw value editing

## Color Scheme

```
Background:      #0b1018  (near-black)
Panel:           #0e1420  (dark navy)
Surface:         #111820  (slightly lighter)
Accent:          #00b4d8  (Dolby cyan)
Accent bright:   #00d4ff  (bright cyan for active states)
Active toggle:   #00c853  (green)
Inactive toggle: #1a2535  (dark gray)
Text primary:    #d0d8e4  (light gray)
Text secondary:  #607080  (muted)
Border:          #1a2535  (subtle)
Bar gradient:    #004860 → #00d4ff (bottom to top)
```

## Profile Parameter Defaults (from ds1-default.xml)

| Parameter | Movie | Music | Game | Voice | Custom 1 | Custom 2 |
|-----------|-------|-------|------|-------|----------|----------|
| IEQ preset | rich | rich | open | rich | rich | rich |
| deon (Dialog) | 1 | 1 | 0 | 1 | 0 | 0 |
| dea (Dialog amt) | 3 | 2 | 7 | 10 | 7 | 7 |
| dvle (Leveler) | 0 | 0 | 1 | 0 | 0 | 0 |
| dvla (Leveler amt) | 7 | 4 | 0 | 0 | 5 | 5 |
| vdhe (Headphone) | 2 | 2 | 2 | 0 | 0 | 0 |
| dhsb (HP boost) | 96 | 48 | 0 | 0 | 48 | 48 |
| ngon (Surround) | 2 | 2 | 2 | 2 | 2 | 2 |
| vmb (Vol boost) | 144 | 144 | 144 | 144 | 144 | 144 |
| vmon (Vol max) | 0 | 0 | 2 | 0 | 2 | 2 |
| vspe (Virt spkr) | 0 | 0 | 2 | 0 | 0 | 0 |
| plmd (Limiter) | 4 | 4 | 4 | 4 | 4 | 4 |
| aoon (Audio opt) | 2 | 2 | 2 | 2 | 2 | 2 |
| iea (IEQ amount) | 10 | 10 | 10 | 10 | 10 | 10 |
| ieon (IEQ on) | 0 | 0 | 0 | 0 | 0 | 0 |

## Control Protocol Extension

Current pipe protocol handles audio. Control commands use reserved frame_count
values (0xFFFFFFF0–0xFFFFFFFE):

```
CMD_SET_PARAM   = 0xFFFFFFF0
  Write: uint32 cmd + uint16 param_index + int16 value
  Read:  uint32 ack (0 = success)

CMD_SET_PROFILE = 0xFFFFFFF1
  Write: uint32 cmd + uint32 profile_id
  Read:  uint32 ack

CMD_GET_VIS     = 0xFFFFFFF2
  Write: uint32 cmd
  Read:  int16[20] band_levels
```

Commands are sent between audio blocks — no threading needed.
Parameter changes apply on the next audio block (glitch-free).

## Implementation Phases

### Phase 1: Protocol extension
- Add CMD_SET_PARAM/CMD_SET_PROFILE to ddp_processor.c main loop
- Bridge forwards control commands transparently
- Test: change parameters live via test script

### Phase 2: VST editor shell
- Implement effEditOpen/Close/GetRect/Idle in ddp_vst.c
- Create child HWND with Win32, paint background
- Verify editor appears in EqualizerAPO

### Phase 3: Interactive controls
- Profile buttons, toggle switches, amount sliders
- IEQ mode selector (Open/Rich/Focused/Manual)
- Wire controls to CMD_SET_PARAM via pipe
- Parameter changes applied between audio blocks (thread-safe)

### Phase 4: Visualizer
- 20-band frequency bar display (from CMD_GET_VIS)
- EQ curve overlay (Catmull-Rom spline through 5 control points)
- Draggable EQ knobs in Manual mode
- Smooth animation (requestAnimationFrame equivalent via WM_TIMER)

### Phase 5: Advanced panel
- All parameters with proper ranges
- Profile import/export as JSON
- Pre/post gain sliders

## Technology: Win32 GDI+ Custom Drawing

- No external dependencies (GDI+ is built into Windows)
- Anti-aliased lines, gradients, alpha blending for the Dolby aesthetic
- Compiles with MinGW (link -lgdiplus)
- Works in all VST2 hosts
- Full pixel-level control for the dark theme

## Thread Safety

- UI runs on host GUI thread (effEditIdle → WM_PAINT)
- Audio runs on audio thread (processReplacing)
- Lock-free ring buffer for UI → audio parameter updates
- Atomic overwrite buffer for audio → UI visualizer data
- Parameters queued and applied between audio blocks only
