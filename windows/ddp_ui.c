/*
 * ddp_ui.c — DolbyX VST Editor UI implementation
 *
 * Win32 GDI custom-drawn editor with Dolby-inspired dark theme.
 * One-page layout: profiles → visualizer → toggles → EQ → advanced
 *
 * All drawing uses double-buffered GDI. Controls send commands via
 * the lock-free CmdQueue, which the audio thread drains each block.
 */

#include <windows.h>
#include <stdio.h>
#include <math.h>
#include "ddp_ui.h"

/* ── Layout Constants ─────────────────────────────────────────────── */

#define HEADER_H     44
#define PROF_Y       (HEADER_H + 8)
#define PROF_H       42
#define PROF_COLS    6
#define PROF_GAP     6
#define PROF_MARGIN  16

#define VIS_Y        (PROF_Y + PROF_H + 12)
#define VIS_H        100
#define VIS_MARGIN   16

#define TOGGLE_Y     (VIS_Y + VIS_H + 12)
#define TOGGLE_H     36
#define TOGGLE_GAP   4

#define IEQ_Y        (TOGGLE_Y + TOGGLE_H * 3 + TOGGLE_GAP * 3 + 10)
#define IEQ_H        36

#define ADV_Y        (IEQ_Y + IEQ_H + 12)

/* ── Drawing Helpers ──────────────────────────────────────────────── */

static void fill_rect(HDC dc, int x, int y, int w, int h, COLORREF col) {
    RECT r = {x, y, x + w, y + h};
    HBRUSH br = CreateSolidBrush(col);
    FillRect(dc, &r, br);
    DeleteObject(br);
}

static void draw_rounded_rect(HDC dc, int x, int y, int w, int h,
                               int radius, COLORREF fill, COLORREF border) {
    HBRUSH br = CreateSolidBrush(fill);
    HPEN pen = CreatePen(PS_SOLID, 1, border);
    HBRUSH obr = SelectObject(dc, br);
    HPEN open = SelectObject(dc, pen);
    RoundRect(dc, x, y, x + w, y + h, radius, radius);
    SelectObject(dc, obr);
    SelectObject(dc, open);
    DeleteObject(br);
    DeleteObject(pen);
}

static void draw_text_left(HDC dc, int x, int y, const char *text,
                            HFONT font, COLORREF col) {
    HFONT of = SelectObject(dc, font);
    SetTextColor(dc, col);
    SetBkMode(dc, TRANSPARENT);
    TextOutA(dc, x, y, text, (int)strlen(text));
    SelectObject(dc, of);
}

static void draw_text_center(HDC dc, int x, int y, int w, int h,
                              const char *text, HFONT font, COLORREF col) {
    RECT r = {x, y, x + w, y + h};
    HFONT of = SelectObject(dc, font);
    SetTextColor(dc, col);
    SetBkMode(dc, TRANSPARENT);
    DrawTextA(dc, text, -1, &r, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(dc, of);
}

/* ── Gradient bar for visualizer ──────────────────────────────────── */

static void draw_vis_bar(HDC dc, int x, int y, int w, int h, float level) {
    int bar_h = (int)(h * level);
    if (bar_h < 2) bar_h = 2;

    /* Dark base */
    fill_rect(dc, x, y, w, h, COL_PANEL);

    /* Gradient bar: dark cyan at bottom, bright cyan at top */
    for (int i = 0; i < bar_h; i++) {
        float t = (float)i / (float)(h > 0 ? h : 1);
        int r = (int)(0 + t * 0);
        int g = (int)(72 + t * 140);
        int b = (int)(96 + t * 159);
        COLORREF c = RGB(r, g, b);
        fill_rect(dc, x, y + h - 1 - i, w, 1, c);
    }
}

/* ── Toggle Switch Drawing ────────────────────────────────────────── */

static void draw_toggle(HDC dc, int x, int y, int on) {
    int w = 48, h = 24, r = 12;
    COLORREF bg = on ? COL_GREEN : COL_BORDER;
    draw_rounded_rect(dc, x, y, w, h, r * 2, bg, bg);

    /* Knob */
    int knob_x = on ? x + w - h + 2 : x + 2;
    HBRUSH br = CreateSolidBrush(RGB(255, 255, 255));
    HPEN pen = CreatePen(PS_SOLID, 1, RGB(255, 255, 255));
    HBRUSH obr = SelectObject(dc, br);
    HPEN open = SelectObject(dc, pen);
    Ellipse(dc, knob_x, y + 2, knob_x + h - 4, y + h - 2);
    SelectObject(dc, obr);
    SelectObject(dc, open);
    DeleteObject(br);
    DeleteObject(pen);
}

/* ── Slider Drawing ───────────────────────────────────────────────── */

static void draw_slider(HDC dc, int x, int y, int w,
                         int val, int min_val, int max_val) {
    int h = 6, track_y = y + 9;
    float t = (max_val > min_val)
        ? (float)(val - min_val) / (float)(max_val - min_val)
        : 0.0f;
    int fill_w = (int)(w * t);

    /* Track background */
    draw_rounded_rect(dc, x, track_y, w, h, 3, COL_SLIDER_BG, COL_SLIDER_BG);
    /* Filled portion */
    if (fill_w > 0) {
        draw_rounded_rect(dc, x, track_y, fill_w, h, 3, COL_ACCENT, COL_ACCENT);
    }
    /* Thumb */
    int thumb_x = x + fill_w - 6;
    if (thumb_x < x) thumb_x = x;
    HBRUSH br = CreateSolidBrush(COL_ACCENT_BR);
    HPEN pen = CreatePen(PS_SOLID, 1, COL_ACCENT_BR);
    SelectObject(dc, br);
    SelectObject(dc, pen);
    Ellipse(dc, thumb_x, track_y - 4, thumb_x + 14, track_y + h + 4);
    DeleteObject(br);
    DeleteObject(pen);
}

/* ── Send command via queue ───────────────────────────────────────── */

static void send_param(DDPUI *ui, int param_idx, int16_t value) {
    if (!ui->cmdq) return;
    ui->params[param_idx] = value;
    UICommand cmd = {
        .type = DDP_CMD_SET_PARAM,
        .param_idx = (uint16_t)param_idx,
        .value = value
    };
    cmdq_push(ui->cmdq, &cmd);
}

static void send_profile(DDPUI *ui, int profile_id) {
    if (!ui->cmdq) return;
    ui->profile = profile_id;
    UICommand cmd = {
        .type = DDP_CMD_SET_PROFILE,
        .profile_id = (uint32_t)profile_id
    };
    cmdq_push(ui->cmdq, &cmd);
}

/* ── Main Paint ───────────────────────────────────────────────────── */

static void paint(DDPUI *ui) {
    HDC dc = ui->memdc;
    int W = ui->width, H = ui->height;

    /* Background */
    fill_rect(dc, 0, 0, W, H, COL_BG);

    /* ── Header ───────────────────────────────────────────────────── */
    fill_rect(dc, 0, 0, W, HEADER_H, COL_PANEL);

    /* Power indicator */
    HBRUSH pbr = CreateSolidBrush(ui->power ? COL_ACCENT : COL_BORDER);
    HPEN ppen = CreatePen(PS_SOLID, 2, ui->power ? COL_ACCENT : COL_BORDER);
    SelectObject(dc, pbr);
    SelectObject(dc, ppen);
    Ellipse(dc, 12, 8, 38, 34);
    DeleteObject(pbr);
    DeleteObject(ppen);

    draw_text_left(dc, 46, 10, "DOLBY", ui->font_title, COL_ACCENT);
    draw_text_left(dc, W - 60, 14, "DolbyX", ui->font_small, COL_TEXT_DIM);

    /* ── Profile Selector (3×2 tabs) ──────────────────────────────── */
    {
        static const char *names[] = {
            "Movie", "Music", "Game", "Voice", "Custom 1", "Custom 2"
        };
        int total_w = W - PROF_MARGIN * 2;
        int btn_w = (total_w - (PROF_COLS - 1) * PROF_GAP) / PROF_COLS;

        for (int i = 0; i < 6; i++) {
            int col = i;
            int x = PROF_MARGIN + col * (btn_w + PROF_GAP);
            int y = PROF_Y;
            int active = (i == ui->profile);

            COLORREF bg = active ? RGB(0, 180, 216) : COL_SURFACE;
            COLORREF border = active ? COL_ACCENT : COL_BORDER;
            COLORREF text_col = active ? RGB(0, 0, 0) : COL_TEXT;

            draw_rounded_rect(dc, x, y, btn_w, PROF_H, 10, bg, border);
            draw_text_center(dc, x, y, btn_w, PROF_H,
                             names[i], ui->font_normal, text_col);
        }
    }

    /* ── Visualizer ───────────────────────────────────────────────── */
    {
        int vx = VIS_MARGIN, vy = VIS_Y;
        int vw = W - VIS_MARGIN * 2, vh = VIS_H;

        fill_rect(dc, vx, vy, vw, vh, COL_PANEL);

        int bands = 20;
        int bar_gap = 2;
        int bar_w = (vw - (bands + 1) * bar_gap) / bands;

        for (int i = 0; i < bands; i++) {
            int bx = vx + bar_gap + i * (bar_w + bar_gap);
            /* Animate placeholder bars */
            float level = 0.15f + 0.35f * sinf(i * 0.5f + ui->vis_bars[0]);
            draw_vis_bar(dc, bx, vy + 2, bar_w, vh - 4, level);
        }
    }

    /* ── Toggles with Sliders ─────────────────────────────────────── */
    {
        struct {
            const char *label;
            int enable_param;     /* param index for ON/OFF */
            int amount_param;     /* param index for amount slider */
            int amount_min, amount_max;
            int on_value;         /* value when "ON" */
        } toggles[] = {
            {"Volume Leveler",     DDP_PARAM_DVLE, DDP_PARAM_DVLA, 0, 10, 1},
            {"Dialogue Enhancer",  DDP_PARAM_DEON, DDP_PARAM_DEA,  0, 16, 1},
            {"Surround Virtualizer", DDP_PARAM_VDHE, DDP_PARAM_DHSB, 0, 192, 2},
        };

        for (int i = 0; i < 3; i++) {
            int y = TOGGLE_Y + i * (TOGGLE_H + TOGGLE_GAP);
            int is_on = (ui->params[toggles[i].enable_param] > 0);

            /* Label */
            draw_text_left(dc, PROF_MARGIN, y + 8,
                           toggles[i].label, ui->font_normal, COL_TEXT);

            /* Slider */
            int slider_x = 280, slider_w = 180;
            int val = ui->params[toggles[i].amount_param];
            draw_slider(dc, slider_x, y + 4, slider_w,
                        val, toggles[i].amount_min, toggles[i].amount_max);

            /* Value label */
            char vbuf[16];
            snprintf(vbuf, sizeof(vbuf), "%d", val);
            draw_text_left(dc, slider_x + slider_w + 8, y + 8,
                           vbuf, ui->font_small, COL_TEXT_DIM);

            /* Toggle switch */
            draw_toggle(dc, W - PROF_MARGIN - 52, y + 6, is_on);

            /* Separator line */
            if (i < 2) {
                HPEN sep = CreatePen(PS_SOLID, 1, RGB(20, 28, 40));
                SelectObject(dc, sep);
                MoveToEx(dc, PROF_MARGIN, y + TOGGLE_H + 1, NULL);
                LineTo(dc, W - PROF_MARGIN, y + TOGGLE_H + 1);
                DeleteObject(sep);
            }
        }
    }

    /* ── IEQ Mode Selector ────────────────────────────────────────── */
    {
        static const char *modes[] = {"Open", "Rich", "Focused", "Manual"};
        int total_w = W - PROF_MARGIN * 2;
        int btn_w = (total_w - 3 * PROF_GAP) / 4;

        /* Label */
        const char *mode_label = ui->ieq_mode == DDP_IEQ_MANUAL
            ? "Graphic EQ" : "Intelligent EQ";
        char label_buf[64];
        snprintf(label_buf, sizeof(label_buf), "%s:  %s",
                 mode_label, modes[ui->ieq_mode]);
        draw_text_left(dc, PROF_MARGIN, IEQ_Y - 18,
                       label_buf, ui->font_small, COL_TEXT_DIM);

        for (int i = 0; i < 4; i++) {
            int x = PROF_MARGIN + i * (btn_w + PROF_GAP);
            int y = IEQ_Y;
            int active = (i == ui->ieq_mode);

            COLORREF bg = active ? RGB(0, 30, 50) : COL_SURFACE;
            COLORREF border = active ? COL_ACCENT : COL_BORDER;
            COLORREF text_col = active ? COL_ACCENT_BR : COL_TEXT;

            draw_rounded_rect(dc, x, y, btn_w, IEQ_H, 10, bg, border);
            draw_text_center(dc, x, y, btn_w, IEQ_H,
                             modes[i], ui->font_normal, text_col);
        }
    }

    /* ── Advanced Section ─────────────────────────────────────────── */
    {
        int y = ADV_Y;
        draw_text_left(dc, PROF_MARGIN, y,
                       "Advanced", ui->font_small, COL_TEXT_DIM);
        y += 20;

        /* Pre-gain slider */
        draw_text_left(dc, PROF_MARGIN, y + 4, "Pre-gain", ui->font_small, COL_TEXT_DIM);
        draw_slider(dc, 120, y, 180, 6, 0, 12);  /* -6 mapped to 0-12 range */
        draw_text_left(dc, 308, y + 4, "-6 dB", ui->font_small, COL_TEXT_DIM);

        /* Post-gain slider */
        draw_text_left(dc, 360, y + 4, "Post-gain", ui->font_small, COL_TEXT_DIM);
        draw_slider(dc, 460, y, 140, 0, 0, 12);
        draw_text_left(dc, 608, y + 4, "0 dB", ui->font_small, COL_TEXT_DIM);
    }

    /* Update visualizer animation counter */
    ui->vis_bars[0] += 0.12f;
}

/* ── Hit Testing ──────────────────────────────────────────────────── */

static int hit_profile(DDPUI *ui, int mx, int my) {
    if (my < PROF_Y || my > PROF_Y + PROF_H) return -1;
    int total_w = ui->width - PROF_MARGIN * 2;
    int btn_w = (total_w - (PROF_COLS - 1) * PROF_GAP) / PROF_COLS;
    int col = (mx - PROF_MARGIN) / (btn_w + PROF_GAP);
    if (col < 0 || col >= 6) return -1;
    return col;
}

static int hit_toggle(DDPUI *ui, int mx, int my) {
    /* Returns 0-2 for the toggle switch area, -1 for miss */
    for (int i = 0; i < 3; i++) {
        int y = TOGGLE_Y + i * (TOGGLE_H + TOGGLE_GAP);
        int tx = ui->width - PROF_MARGIN - 52;
        if (mx >= tx && mx <= tx + 48 && my >= y + 4 && my <= y + TOGGLE_H) {
            return i;
        }
    }
    return -1;
}

static int hit_slider(DDPUI *ui, int mx, int my) {
    /* Returns 0-2 for slider area, -1 for miss */
    for (int i = 0; i < 3; i++) {
        int y = TOGGLE_Y + i * (TOGGLE_H + TOGGLE_GAP);
        if (mx >= 280 && mx <= 460 && my >= y && my <= y + TOGGLE_H) {
            return i;
        }
    }
    return -1;
}

static int hit_ieq(DDPUI *ui, int mx, int my) {
    if (my < IEQ_Y || my > IEQ_Y + IEQ_H) return -1;
    int total_w = ui->width - PROF_MARGIN * 2;
    int btn_w = (total_w - 3 * PROF_GAP) / 4;
    int col = (mx - PROF_MARGIN) / (btn_w + PROF_GAP);
    if (col < 0 || col >= 4) return -1;
    return col;
}

/* ── Slider Value from Mouse X ────────────────────────────────────── */

static int slider_value_from_x(int mx, int slider_x, int slider_w,
                                int min_val, int max_val) {
    float t = (float)(mx - slider_x) / (float)slider_w;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return min_val + (int)(t * (max_val - min_val) + 0.5f);
}

/* ── Window Procedure ─────────────────────────────────────────────── */

static const int g_slider_params[][4] = {
    /* {enable_param, amount_param, min, max} */
    {DDP_PARAM_DVLE, DDP_PARAM_DVLA, 0, 10},
    {DDP_PARAM_DEON, DDP_PARAM_DEA,  0, 16},
    {DDP_PARAM_VDHE, DDP_PARAM_DHSB, 0, 192},
};

static LRESULT CALLBACK ui_wndproc(HWND hwnd, UINT msg,
                                     WPARAM wp, LPARAM lp) {
    DDPUI *ui = (DDPUI *)GetWindowLongPtrA(hwnd, GWLP_USERDATA);

    switch (msg) {
    case WM_PAINT: {
        if (!ui) break;
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        paint(ui);
        BitBlt(hdc, 0, 0, ui->width, ui->height, ui->memdc, 0, 0, SRCCOPY);
        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_TIMER:
        if (ui) InvalidateRect(hwnd, NULL, FALSE);
        return 0;

    case WM_LBUTTONDOWN: {
        if (!ui) break;
        int mx = LOWORD(lp), my = HIWORD(lp);

        /* Power toggle */
        if (mx >= 12 && mx <= 38 && my >= 8 && my <= 34) {
            ui->power = !ui->power;
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Profile click */
        int prof = hit_profile(ui, mx, my);
        if (prof >= 0 && prof != ui->profile) {
            send_profile(ui, prof);
            /* Load profile defaults into UI state */
            extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
            memcpy(ui->params, g_profiles[prof], sizeof(ui->params));
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Toggle click */
        int tog = hit_toggle(ui, mx, my);
        if (tog >= 0) {
            int param = g_slider_params[tog][0];
            int on_val = (tog == 2) ? 2 : 1; /* vdhe uses 2 for AUTO */
            int cur = ui->params[param];
            int16_t new_val = (cur > 0) ? 0 : on_val;
            send_param(ui, param, new_val);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Slider drag start */
        int sl = hit_slider(ui, mx, my);
        if (sl >= 0) {
            ui->drag_slider = sl;
            SetCapture(hwnd);
            int val = slider_value_from_x(mx, 280, 180,
                        g_slider_params[sl][2], g_slider_params[sl][3]);
            send_param(ui, g_slider_params[sl][1], (int16_t)val);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* IEQ mode click */
        int ieq = hit_ieq(ui, mx, my);
        if (ieq >= 0) {
            ui->ieq_mode = ieq;
            if (ieq == DDP_IEQ_MANUAL) {
                send_param(ui, DDP_PARAM_IEON, 0);
                send_param(ui, DDP_PARAM_GEON, 1);
            } else {
                send_param(ui, DDP_PARAM_GEON, 0);
                send_param(ui, DDP_PARAM_IEON, 1);
                /* IEQ preset is set via the IEQ target bands, which
                 * requires a different DS_PARAM command — for now the
                 * processor's profile defaults handle this. */
            }
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }
        break;
    }

    case WM_MOUSEMOVE: {
        if (!ui || ui->drag_slider < 0) break;
        int mx = LOWORD(lp);
        int sl = ui->drag_slider;
        int val = slider_value_from_x(mx, 280, 180,
                    g_slider_params[sl][2], g_slider_params[sl][3]);
        send_param(ui, g_slider_params[sl][1], (int16_t)val);
        InvalidateRect(hwnd, NULL, FALSE);
        return 0;
    }

    case WM_LBUTTONUP:
        if (ui && ui->drag_slider >= 0) {
            ui->drag_slider = -1;
            ReleaseCapture();
        }
        return 0;

    case WM_ERASEBKGND:
        return 1; /* prevent flicker — we paint the entire surface */

    default:
        break;
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

/* ── Window Class ─────────────────────────────────────────────────── */

static const char *UI_CLASS = "DolbyXEditor";
static int g_class_registered = 0;

void ddpui_register_class(HINSTANCE hInst) {
    if (g_class_registered) return;
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = ui_wndproc;
    wc.hInstance = hInst;
    wc.lpszClassName = UI_CLASS;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.style = CS_DBLCLKS;
    RegisterClassA(&wc);
    g_class_registered = 1;
}

/* ── Create / Destroy ─────────────────────────────────────────────── */

DDPUI *ddpui_create(HWND parent, CmdQueue *cmdq) {
    DDPUI *ui = (DDPUI *)calloc(1, sizeof(DDPUI));
    if (!ui) return NULL;

    ui->cmdq = cmdq;
    ui->width = UI_WIDTH;
    ui->height = UI_HEIGHT;
    ui->power = 1;
    ui->profile = DDP_PROFILE_MUSIC;
    ui->ieq_mode = DDP_IEQ_MANUAL;
    ui->drag_slider = -1;
    ui->hover_profile = -1;

    /* Load Music profile defaults */
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    memcpy(ui->params, g_profiles[DDP_PROFILE_MUSIC], sizeof(ui->params));

    /* Fonts */
    ui->font_title  = CreateFontA(22, 0, 0, 0, FW_BOLD, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_normal = CreateFontA(15, 0, 0, 0, FW_NORMAL, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_small  = CreateFontA(12, 0, 0, 0, FW_NORMAL, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_label  = CreateFontA(13, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");

    /* Register window class */
    HINSTANCE hInst = GetModuleHandle(NULL);
    ddpui_register_class(hInst);

    /* Create child window inside host-provided parent */
    ui->hwnd = CreateWindowExA(
        0, UI_CLASS, "DolbyX",
        WS_CHILD | WS_VISIBLE,
        0, 0, UI_WIDTH, UI_HEIGHT,
        parent, NULL, hInst, NULL
    );

    SetWindowLongPtrA(ui->hwnd, GWLP_USERDATA, (LONG_PTR)ui);

    /* Double buffer */
    HDC hdc = GetDC(ui->hwnd);
    ui->memdc = CreateCompatibleDC(hdc);
    ui->membmp = CreateCompatibleBitmap(hdc, UI_WIDTH, UI_HEIGHT);
    SelectObject(ui->memdc, ui->membmp);
    ReleaseDC(ui->hwnd, hdc);

    /* Timer for visualizer animation (~30fps) */
    SetTimer(ui->hwnd, 1, 33, NULL);

    /* Initial paint */
    InvalidateRect(ui->hwnd, NULL, FALSE);

    return ui;
}

void ddpui_destroy(DDPUI *ui) {
    if (!ui) return;
    KillTimer(ui->hwnd, 1);
    DeleteDC(ui->memdc);
    DeleteObject(ui->membmp);
    DeleteObject(ui->font_title);
    DeleteObject(ui->font_normal);
    DeleteObject(ui->font_small);
    DeleteObject(ui->font_label);
    DestroyWindow(ui->hwnd);
    free(ui);
}

void ddpui_idle(DDPUI *ui) {
    if (!ui) return;
    /* Repaint handled by WM_TIMER — idle is a no-op */
}
