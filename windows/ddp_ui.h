/*
 * ddp_ui.h — DolbyX VST Editor UI
 */
#ifndef DDP_UI_H
#define DDP_UI_H

#include <windows.h>
#include <stdint.h>
#include "ddp_protocol.h"

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

/* Per-profile saved state */
typedef struct {
    int16_t  params[DDP_PARAM_COUNT];
    int      ieq_mode;  /* 0=open, 1=rich, 2=focused, 3=manual */
} ProfileState;

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
    ProfileState profiles[DDP_PROFILE_COUNT];  /* persistent per-profile state */

    /* Interaction */
    int      drag_slider;   /* -1=none, 0-2=toggle sliders, 12=VMB */
    int      drag_param;
    int      drag_x0, drag_w, drag_min, drag_max;

    /* Visualizer */
    float    vis_phase;

    /* Control pipe */
    HANDLE   ctrl_pipe;

    /* Config file path (next to DLL) */
    char     config_path[512];
} DDPUI;

/* Convenience accessors */
#define CUR_PARAMS(ui)   ((ui)->profiles[(ui)->profile].params)
#define CUR_IEQ(ui)      ((ui)->profiles[(ui)->profile].ieq_mode)

DDPUI *ddpui_create(HWND parent, const char *dll_dir);
void   ddpui_destroy(DDPUI *ui);
void   ddpui_idle(DDPUI *ui);
void   ddpui_register_class(HINSTANCE hInst);

#endif
