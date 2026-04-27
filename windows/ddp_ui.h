/*
 * ddp_ui.h — DolbyX VST Editor UI definitions
 *
 * One-page layout: profile grid → visualizer → toggles → EQ → advanced
 */
#ifndef DDP_UI_H
#define DDP_UI_H

#include <windows.h>
#include <stdint.h>
#include "ddp_protocol.h"

/* ── Editor Dimensions ────────────────────────────────────────────── */

#define UI_WIDTH    680
#define UI_HEIGHT   530

/* ── Colors (Dolby-inspired dark theme) ───────────────────────────── */

#define COL_BG          RGB(11,  16,  24)   /* #0b1018 */
#define COL_PANEL       RGB(14,  20,  32)   /* #0e1420 */
#define COL_SURFACE     RGB(17,  24,  32)   /* #111820 */
#define COL_BORDER      RGB(26,  37,  53)   /* #1a2535 */
#define COL_ACCENT      RGB(0,  180, 216)   /* #00b4d8 */
#define COL_ACCENT_BR   RGB(0,  212, 255)   /* #00d4ff */
#define COL_GREEN       RGB(0,  200,  83)   /* #00c853 */
#define COL_TEXT        RGB(208, 216, 228)   /* #d0d8e4 */
#define COL_TEXT_DIM    RGB(96,  112, 128)   /* #607080 */
#define COL_SLIDER_BG   RGB(26,  37,  53)   /* #1a2535 */

/* ── Lock-Free Command Queue (UI thread → audio thread) ───────────── */

#define CMD_QUEUE_SIZE 64
#define CMD_QUEUE_MASK (CMD_QUEUE_SIZE - 1)

typedef struct {
    uint32_t type;       /* DDP_CMD_SET_PARAM or DDP_CMD_SET_PROFILE */
    uint16_t param_idx;  /* for SET_PARAM */
    int16_t  value;      /* for SET_PARAM */
    uint32_t profile_id; /* for SET_PROFILE */
} UICommand;

typedef struct {
    UICommand slots[CMD_QUEUE_SIZE];
    volatile LONG write_pos;
    volatile LONG read_pos;
} CmdQueue;

static inline void cmdq_init(CmdQueue *q) {
    q->write_pos = 0;
    q->read_pos = 0;
}

static inline void cmdq_push(CmdQueue *q, UICommand *cmd) {
    LONG wp = InterlockedIncrement(&q->write_pos) - 1;
    q->slots[wp & CMD_QUEUE_MASK] = *cmd;
}

static inline int cmdq_pop(CmdQueue *q, UICommand *out) {
    LONG rp = q->read_pos;
    LONG wp = q->write_pos;
    if (rp >= wp) return 0;
    *out = q->slots[rp & CMD_QUEUE_MASK];
    InterlockedIncrement(&q->read_pos);
    return 1;
}

/* ── UI State ─────────────────────────────────────────────────────── */

typedef struct {
    HWND     hwnd;
    HFONT    font_title;
    HFONT    font_normal;
    HFONT    font_small;
    HFONT    font_label;
    HDC      memdc;
    HBITMAP  membmp;
    int      width, height;

    /* DDP state (mirrored from processor) */
    int      power;
    int      profile;
    int16_t  params[DDP_PARAM_COUNT];
    int      ieq_mode;      /* 0=open, 1=rich, 2=focused, 3=manual */

    /* Interaction */
    int      drag_slider;   /* -1 = none, else param index */
    int      hover_profile; /* -1 = none */

    /* Visualizer bars (placeholder for Phase 4) */
    float    vis_bars[20];

    /* Command queue (shared with audio thread) */
    CmdQueue *cmdq;
} DDPUI;

/* ── Public API ───────────────────────────────────────────────────── */

DDPUI *ddpui_create(HWND parent, CmdQueue *cmdq);
void   ddpui_destroy(DDPUI *ui);
void   ddpui_idle(DDPUI *ui);

/* Window class registration */
void   ddpui_register_class(HINSTANCE hInst);

#endif /* DDP_UI_H */
