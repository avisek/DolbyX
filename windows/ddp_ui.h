/*
 * ddp_ui.h — DolbyX VST Editor UI definitions
 */
#ifndef DDP_UI_H
#define DDP_UI_H

#include <windows.h>
#include <stdint.h>
#include "ddp_protocol.h"

/* Editor base size — rendered at this logical pixel size.
 * No manual DPI scaling; we declare per-monitor DPI awareness
 * and let Windows handle scaling if needed. */
#define UI_WIDTH    720
#define UI_HEIGHT   560

/* Colors */
#define COL_BG          RGB(11,  16,  24)
#define COL_PANEL       RGB(14,  20,  32)
#define COL_SURFACE     RGB(22,  30,  42)
#define COL_BORDER      RGB(32,  44,  60)
#define COL_ACCENT      RGB(0,  180, 216)
#define COL_ACCENT_BR   RGB(0,  212, 255)
#define COL_GREEN       RGB(0,  200,  83)
#define COL_TEXT        RGB(208, 216, 228)
#define COL_TEXT_DIM    RGB(96,  112, 128)
#define COL_SLIDER_BG   RGB(32,  44,  60)

/* UI state */
typedef struct {
    HWND     hwnd;
    HFONT    font_title;
    HFONT    font_normal;
    HFONT    font_small;
    HDC      memdc;
    HBITMAP  membmp;

    /* DDP state */
    int      power;
    int      profile;
    int16_t  params[DDP_PARAM_COUNT];
    int      ieq_mode;

    /* Interaction */
    int      drag_slider;   /* -1=none, 0-4=which slider */
    int      drag_param;    /* param index of dragged slider */
    int      drag_x0, drag_w; /* slider geometry during drag */
    int      drag_min, drag_max;

    /* Visualizer */
    float    vis_phase;

    /* Control pipe */
    HANDLE   ctrl_pipe;

    /* Gain (in 0.1dB units: -60 = -6.0dB) */
    int16_t  pre_gain_x10;   /* -120..0 */
    int16_t  post_gain_x10;  /* 0..120 */
} DDPUI;

DDPUI *ddpui_create(HWND parent);
void   ddpui_destroy(DDPUI *ui);
void   ddpui_idle(DDPUI *ui);
void   ddpui_register_class(HINSTANCE hInst);

#endif
