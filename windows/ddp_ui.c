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

/* ── Control Pipe (direct connection to bridge) ───────────────────── */

#define CTRL_PIPE_NAME  "\\\\.\\pipe\\DolbyXCtrl"

static BOOL ctrl_read(HANDLE h, void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) {
        DWORD r = 0;
        if (!ReadFile(h, (BYTE *)buf + t, n - t, &r, NULL) || r == 0)
            return FALSE;
        t += r;
    }
    return TRUE;
}

static BOOL ctrl_write(HANDLE h, const void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) {
        DWORD w = 0;
        if (!WriteFile(h, (const BYTE *)buf + t, n - t, &w, NULL) || w == 0)
            return FALSE;
        t += w;
    }
    return TRUE;
}

static int ctrl_connect(DDPUI *ui) {
    if (ui->ctrl_pipe != INVALID_HANDLE_VALUE) return 0;

    for (int i = 0; i < 3; i++) {
        ui->ctrl_pipe = CreateFileA(CTRL_PIPE_NAME,
            GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
        if (ui->ctrl_pipe != INVALID_HANDLE_VALUE) break;
        if (GetLastError() == ERROR_PIPE_BUSY)
            WaitNamedPipeA(CTRL_PIPE_NAME, 1000);
        else break;
    }

    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return -1;

    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(ui->ctrl_pipe, &mode, NULL, NULL);

    DWORD magic = 0;
    if (!ctrl_read(ui->ctrl_pipe, &magic, 4) || magic != DDP_READY_MAGIC) {
        CloseHandle(ui->ctrl_pipe);
        ui->ctrl_pipe = INVALID_HANDLE_VALUE;
        return -1;
    }
    return 0;
}

static void ctrl_disconnect(DDPUI *ui) {
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    DWORD cmd = DDP_CMD_SHUTDOWN;
    ctrl_write(ui->ctrl_pipe, &cmd, 4);
    CloseHandle(ui->ctrl_pipe);
    ui->ctrl_pipe = INVALID_HANDLE_VALUE;
}

static void send_param(DDPUI *ui, int param_idx, int16_t value) {
    ui->params[param_idx] = value;
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) ctrl_connect(ui);
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;

    DWORD cmd = DDP_CMD_SET_PARAM;
    uint16_t idx = (uint16_t)param_idx;
    int16_t val = value;
    ctrl_write(ui->ctrl_pipe, &cmd, 4);
    ctrl_write(ui->ctrl_pipe, &idx, 2);
    ctrl_write(ui->ctrl_pipe, &val, 2);
    DWORD status = 0;
    ctrl_read(ui->ctrl_pipe, &status, 4);
}

static void send_profile(DDPUI *ui, int profile_id) {
    ui->profile = profile_id;
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) ctrl_connect(ui);
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;

    DWORD cmd = DDP_CMD_SET_PROFILE;
    DWORD pid = (DWORD)profile_id;
    ctrl_write(ui->ctrl_pipe, &cmd, 4);
    ctrl_write(ui->ctrl_pipe, &pid, 4);
    DWORD status = 0;
    ctrl_read(ui->ctrl_pipe, &status, 4);
}

/* ── Main Paint ───────────────────────────────────────────────────── */

static void paint(DDPUI *ui) {
    HDC dc = ui->memdc;
    int W = ui->width, H = ui->height;
    float S = ui->dpi_scale;  /* scale factor for all coordinates */

    /* Scaled layout values */
    int header_h = (int)(header_h * S);
    int prof_y = (int)(prof_y * S);
    int prof_h = (int)(PROF_H * S);
    int prof_margin = (int)(prof_margin * S);
    int prof_gap = (int)(prof_gap * S);
    int vis_y = (int)(vis_y * S);
    int vis_h = (int)(vis_h * S);
    int vis_margin = (int)(vis_margin * S);
    int toggle_y = (int)(toggle_y * S);
    int toggle_h = (int)(toggle_h * S);
    int toggle_gap = (int)(toggle_gap * S);
    int ieq_y = (int)(ieq_y * S);
    int ieq_h = (int)(ieq_h * S);
    int adv_y = (int)(adv_y * S);

    /* Background */
    fill_rect(dc, 0, 0, W, H, COL_BG);

    /* ── Header ───────────────────────────────────────────────────── */
    fill_rect(dc, 0, 0, W, header_h, COL_PANEL);

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
        int total_w = W - prof_margin * 2;
        int btn_w = (total_w - (6 - 1) * prof_gap) / 6;

        for (int i = 0; i < 6; i++) {
            int col = i;
            int x = prof_margin + col * (btn_w + prof_gap);
            int y = prof_y;
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
        int vx = vis_margin, vy = vis_y;
        int vw = W - vis_margin * 2, vh = vis_h;

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
            int y = toggle_y + i * (toggle_h + toggle_gap);
            int is_on = (ui->params[toggles[i].enable_param] > 0);

            /* Label */
            draw_text_left(dc, prof_margin, y + 8,
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
            draw_toggle(dc, W - prof_margin - 52, y + 6, is_on);

            /* Separator line */
            if (i < 2) {
                HPEN sep = CreatePen(PS_SOLID, 1, RGB(20, 28, 40));
                SelectObject(dc, sep);
                MoveToEx(dc, prof_margin, y + toggle_h + 1, NULL);
                LineTo(dc, W - prof_margin, y + toggle_h + 1);
                DeleteObject(sep);
            }
        }
    }

    /* ── IEQ Mode Selector ────────────────────────────────────────── */
    {
        static const char *modes[] = {"Open", "Rich", "Focused", "Manual"};
        int total_w = W - prof_margin * 2;
        int btn_w = (total_w - 3 * prof_gap) / 4;

        /* Label */
        const char *mode_label = ui->ieq_mode == DDP_IEQ_MANUAL
            ? "Graphic EQ" : "Intelligent EQ";
        char label_buf[64];
        snprintf(label_buf, sizeof(label_buf), "%s:  %s",
                 mode_label, modes[ui->ieq_mode]);
        draw_text_left(dc, prof_margin, ieq_y - 18,
                       label_buf, ui->font_small, COL_TEXT_DIM);

        for (int i = 0; i < 4; i++) {
            int x = prof_margin + i * (btn_w + prof_gap);
            int y = ieq_y;
            int active = (i == ui->ieq_mode);

            COLORREF bg = active ? RGB(0, 30, 50) : COL_SURFACE;
            COLORREF border = active ? COL_ACCENT : COL_BORDER;
            COLORREF text_col = active ? COL_ACCENT_BR : COL_TEXT;

            draw_rounded_rect(dc, x, y, btn_w, ieq_h, 10, bg, border);
            draw_text_center(dc, x, y, btn_w, ieq_h,
                             modes[i], ui->font_normal, text_col);
        }
    }

    /* ── Advanced Section ─────────────────────────────────────────── */
    {
        int y = adv_y;
        draw_text_left(dc, prof_margin, y,
                       "Advanced", ui->font_small, COL_TEXT_DIM);
        y += 20;

        /* Pre-gain slider */
        draw_text_left(dc, prof_margin, y + (int)(4*S), "Pre-gain", ui->font_small, COL_TEXT_DIM);
        draw_slider(dc, (int)(120*S), y, (int)(180*S), 6, 0, 12);  /* -6 mapped to 0-12 range */
        draw_text_left(dc, 308, y + (int)(4*S), "-6 dB", ui->font_small, COL_TEXT_DIM);

        /* Post-gain slider */
        draw_text_left(dc, 360, y + (int)(4*S), "Post-gain", ui->font_small, COL_TEXT_DIM);
        draw_slider(dc, (int)(460*S), y, (int)(140*S), 0, 0, 12);
        draw_text_left(dc, 608, y + (int)(4*S), "0 dB", ui->font_small, COL_TEXT_DIM);
    }

    /* Update visualizer animation counter */
    ui->vis_bars[0] += 0.12f;
}

/* ── Hit Testing ──────────────────────────────────────────────────── */

static int hit_profile(DDPUI *ui, int mx, int my) {
    float S = ui->dpi_scale;
    int y0 = (int)(PROF_Y * S), y1 = y0 + (int)(PROF_H * S);
    if (my < y0 || my > y1) return -1;
    int margin = (int)(PROF_MARGIN * S);
    int gap = (int)(PROF_GAP * S);
    int total_w = ui->width - margin * 2;
    int btn_w = (total_w - 5 * gap) / 6;
    int col = (mx - margin) / (btn_w + gap);
    if (col < 0 || col >= 6) return -1;
    return col;
}

static int hit_toggle(DDPUI *ui, int mx, int my) {
    float S = ui->dpi_scale;
    int margin = (int)(PROF_MARGIN * S);
    for (int i = 0; i < 3; i++) {
        int y = (int)(TOGGLE_Y * S) + i * ((int)(TOGGLE_H * S) + (int)(TOGGLE_GAP * S));
        int tx = ui->width - margin - (int)(52 * S);
        if (mx >= tx && mx <= tx + (int)(48 * S) &&
            my >= y + (int)(4 * S) && my <= y + (int)(TOGGLE_H * S)) {
            return i;
        }
    }
    return -1;
}

static int hit_slider(DDPUI *ui, int mx, int my) {
    float S = ui->dpi_scale;
    int sx = (int)(280 * S), sw = (int)(180 * S);
    for (int i = 0; i < 3; i++) {
        int y = (int)(TOGGLE_Y * S) + i * ((int)(TOGGLE_H * S) + (int)(TOGGLE_GAP * S));
        if (mx >= sx && mx <= sx + sw && my >= y && my <= y + (int)(TOGGLE_H * S))
            return i;
    }
    return -1;
}

static int hit_ieq(DDPUI *ui, int mx, int my) {
    float S = ui->dpi_scale;
    int y0 = (int)(IEQ_Y * S), y1 = y0 + (int)(IEQ_H * S);
    if (my < y0 || my > y1) return -1;
    int margin = (int)(PROF_MARGIN * S);
    int gap = (int)(PROF_GAP * S);
    int total_w = ui->width - margin * 2;
    int btn_w = (total_w - 3 * gap) / 4;
    int col = (mx - margin) / (btn_w + gap);
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
            float S = ui->dpi_scale;
            int sx = (int)(280 * S), sw = (int)(180 * S);
            int val = slider_value_from_x(mx, sx, sw,
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
        float S = ui->dpi_scale;
        int sx = (int)(280 * S), sw = (int)(180 * S);
        int val = slider_value_from_x(mx, sx, sw,
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

DDPUI *ddpui_create(HWND parent) {
    DDPUI *ui = (DDPUI *)calloc(1, sizeof(DDPUI));
    if (!ui) return NULL;

    ui->ctrl_pipe = INVALID_HANDLE_VALUE;
    ui->power = 1;
    ui->profile = DDP_PROFILE_MUSIC;
    ui->ieq_mode = DDP_IEQ_MANUAL;
    ui->drag_slider = -1;
    ui->hover_profile = -1;

    /* DPI scaling */
    HDC screen = GetDC(NULL);
    int dpi = GetDeviceCaps(screen, LOGPIXELSX);
    ReleaseDC(NULL, screen);
    ui->dpi_scale = (float)dpi / 96.0f;
    if (ui->dpi_scale < 1.0f) ui->dpi_scale = 1.0f;

    ui->width  = (int)(UI_WIDTH * ui->dpi_scale);
    ui->height = (int)(UI_HEIGHT * ui->dpi_scale);

    /* Load Music profile defaults */
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    memcpy(ui->params, g_profiles[DDP_PROFILE_MUSIC], sizeof(ui->params));

    /* Fonts — scale with DPI */
    int fs_title  = (int)(22 * ui->dpi_scale);
    int fs_normal = (int)(15 * ui->dpi_scale);
    int fs_small  = (int)(12 * ui->dpi_scale);
    int fs_label  = (int)(13 * ui->dpi_scale);

    ui->font_title  = CreateFontA(fs_title, 0, 0, 0, FW_BOLD, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_normal = CreateFontA(fs_normal, 0, 0, 0, FW_NORMAL, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_small  = CreateFontA(fs_small, 0, 0, 0, FW_NORMAL, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_label  = CreateFontA(fs_label, 0, 0, 0, FW_SEMIBOLD, 0, 0, 0,
        DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, "Segoe UI");

    HINSTANCE hInst = GetModuleHandle(NULL);
    ddpui_register_class(hInst);

    ui->hwnd = CreateWindowExA(
        0, UI_CLASS, "DolbyX",
        WS_CHILD | WS_VISIBLE,
        0, 0, ui->width, ui->height,
        parent, NULL, hInst, NULL
    );

    SetWindowLongPtrA(ui->hwnd, GWLP_USERDATA, (LONG_PTR)ui);

    HDC hdc = GetDC(ui->hwnd);
    ui->memdc = CreateCompatibleDC(hdc);
    ui->membmp = CreateCompatibleBitmap(hdc, ui->width, ui->height);
    SelectObject(ui->memdc, ui->membmp);
    ReleaseDC(ui->hwnd, hdc);

    SetTimer(ui->hwnd, 1, 33, NULL);

    /* Connect to control pipe */
    ctrl_connect(ui);

    InvalidateRect(ui->hwnd, NULL, FALSE);
    return ui;
}

void ddpui_destroy(DDPUI *ui) {
    if (!ui) return;
    KillTimer(ui->hwnd, 1);
    ctrl_disconnect(ui);
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
