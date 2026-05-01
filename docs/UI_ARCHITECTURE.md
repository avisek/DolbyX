# DolbyX UI Architecture — Analysis & Recommendation

## Current Problems with Win32 GDI

1. **No DPI scaling** — Windows GDI coordinates are in physical pixels. At 200% 
   DPI, our 720x460 window renders at half the expected size. Manual scaling 
   means duplicating every coordinate.

2. **No keyboard accessibility** — GDI custom drawing has no concept of focus, 
   tab order, or ARIA semantics. Everything must be implemented from scratch.

3. **Absolute positioning nightmare** — Every pixel offset is hardcoded. Adding 
   or moving a control means updating coordinates in paint(), hit testing, 
   and drag handling — three places that must stay in sync.

4. **No animation primitives** — Smooth transitions (power fade, slider spring, 
   hover effects) require manual state machines and timers.

5. **Visualizer will be painful** — Canvas-like drawing (anti-aliased curves, 
   gradient fills, draggable bezier handles) is extremely verbose in GDI.

6. **Not portable** — GDI code is Windows-only. Future macOS/Linux support 
   would require a complete rewrite.

## Option 1: Web UI via Embedded HTTP Server (RECOMMENDED)

### Architecture

```
┌──────────────────────────────────────────────────────┐
│  Browser (localhost:9876)                             │
│  ┌────────────────────────────────────────────────┐  │
│  │  HTML/CSS/JS                                   │  │
│  │  - Responsive flexbox/grid layout              │  │
│  │  - Canvas visualizer with EQ curve overlay     │  │
│  │  - Draggable EQ knobs (SVG circles)            │  │
│  │  - CSS transitions for smooth state changes    │  │
│  │  - Keyboard accessible (tab, arrow keys)       │  │
│  │  - Native DPI (browser handles everything)     │  │
│  └────────────┬───────────────────────────────────┘  │
│               │ WebSocket ws://localhost:9876/ws      │
└───────────────┼──────────────────────────────────────┘
                │
┌───────────────┼──────────────────────────────────────┐
│  dolbyx-bridge.exe                                    │
│               │                                       │
│  ┌────────────┴───────────────┐                      │
│  │  HTTP server (port 9876)   │                      │
│  │  - Serves index.html       │                      │
│  │  - WebSocket endpoint      │                      │
│  │  - JSON control protocol   │                      │
│  └────────────┬───────────────┘                      │
│               │                                       │
│  ┌────────────┴───────────────┐                      │
│  │  Audio pipes \\.\pipe\...  │                      │
│  │  Processor management      │                      │
│  └────────────────────────────┘                      │
└──────────────────────────────────────────────────────┘
```

### WebSocket Protocol (JSON)

```
Client → Server:
  {"cmd":"set_profile","id":1}
  {"cmd":"set_param","index":7,"value":1}
  {"cmd":"set_ieq","preset":1}
  {"cmd":"power","on":true}
  {"cmd":"get_state"}

Server → Client:
  {"type":"state","profile":1,"power":true,"params":[2,2,48,...],"ieq":3}
  {"type":"vis","bands":[120,85,200,...]}  // 30fps stream
  {"type":"ack","cmd":"set_param","ok":true}
```

### Pros
- **Native DPI** — browser handles all scaling perfectly
- **Responsive layout** — CSS flexbox/grid adapts to any window size
- **Keyboard accessible** — tab navigation, ARIA, focus management
- **Rich visualizer** — Canvas API with requestAnimationFrame, 
  anti-aliased curves, gradients, alpha blending, all trivially
- **Draggable EQ** — SVG circles with pointer events, smooth
- **CSS animations** — power fade, hover glow, slider transitions
- **Cross-platform** — same HTML works on macOS/Linux
- **Hot-reload dev** — edit HTML, refresh browser, instant feedback
- **Zero external deps** — HTTP/WebSocket in C is ~300 lines

### Cons
- **Not embedded in VST panel** — opens in browser, not EqualizerAPO
- **User must open browser** — extra step (but can auto-launch)
- **Bridge must run** — but it already must for audio

### Implementation Complexity
- HTTP server in C: ~100 lines (serve one static page)
- WebSocket in C: ~200 lines (RFC 6455 framing + handshake)
- HTML/CSS/JS: embedded as C string or served from file
- Total: ~500 lines of new C code + ~400 lines of HTML/JS

### How to Handle Bidirectional Visualizer Data

The bridge polls the processor for visualizer data (CMD_GET_VIS) at 30fps
in a dedicated thread, then broadcasts to all connected WebSocket clients:

```c
// In bridge: visualizer pump thread
while (running) {
    // Read vis data from active processor
    BYTE vis_cmd[4] = {0xF2, 0xFF, 0xFF, 0xFF}; // GET_VIS
    proc_ctrl(active_proc, vis_cmd, 4, vis_reply, 40);
    
    // Broadcast to all WebSocket clients
    char json[256];
    snprintf(json, sizeof(json), "{\"type\":\"vis\",\"bands\":[%d,%d,...]}",
             vis_reply[0], vis_reply[1], ...);
    ws_broadcast(json);
    
    Sleep(33); // ~30fps
}
```

## Option 2: Dear ImGui in VST

### Pros
- Embedded in VST panel (shows in EqualizerAPO)
- Good DPI scaling support
- Immediate-mode = no state sync issues
- Rich widget library

### Cons
- Requires OpenGL/DirectX context in VST host (not all support it)
- ~500KB dependency
- Custom theming for Dolby aesthetic is extra work
- Visualizer still needs custom drawing
- C++ dependency (MinGW build gets complex)

## Option 3: Keep GDI but with Layout Engine

Add a simple layout system (computed rects, flex-like positioning).
Still limited by GDI's rendering quality and no keyboard support.

## Recommendation

**Go with the Web UI (Option 1).** Here's why:

1. The VST is already not standalone — it needs the bridge running. The web 
   UI is served by the bridge, so it doesn't add a new dependency.

2. The bridge already handles control commands via named pipes. Adding 
   HTTP/WebSocket is a natural extension of the same IPC pattern.

3. The visualizer with draggable EQ curve is trivial in Canvas/SVG but 
   extremely painful in GDI. This alone saves weeks of work.

4. DPI, keyboard, responsiveness — all solved by the browser, zero effort.

5. Cross-platform: the same HTML/JS works on macOS Safari, Linux Firefox, etc.

6. The existing GDI editor can stay as a minimal fallback (profile/toggle only).

### Suggested Next Steps

1. Add HTTP + WebSocket server to the bridge (~300 lines of C)
2. Create the web UI HTML/CSS/JS (embed in bridge as C string)
3. Wire WebSocket messages to the existing control pipe protocol
4. Add visualizer data pump (30fps CMD_GET_VIS → WebSocket broadcast)
5. Auto-launch browser when bridge starts (ShellExecute)
6. Keep existing GDI editor as minimal fallback

### Timeline

| Step | Effort |
|------|--------|
| HTTP/WS server in bridge | 1-2 days |
| Web UI (profiles, toggles, IEQ) | 1 day |
| Visualizer + EQ curve | 2-3 days |
| Polish + keyboard accessibility | 1 day |
| **Total** | **~5-7 days** |
