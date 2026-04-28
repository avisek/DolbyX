/*
 * ddp_ui.c — DolbyX VST Editor UI
 *
 * Clean GDI custom-drawn editor. Fixed 720x560 logical pixels.
 * All interactive regions computed once in layout(), used by both
 * paint() and hit-testing, so they can never go out of sync.
 */

#include <windows.h>
#include <stdio.h>
#include <math.h>
#include "ddp_ui.h"

/* ── Layout Geometry (all in logical pixels) ──────────────────────── */

#define LM  20       /* left margin */
#define RM  20       /* right margin */
#define CW  (UI_WIDTH - LM - RM)  /* content width = 680 */

/* Vertical positions */
#define HEADER_Y    0
#define HEADER_H    48
#define PROF_Y      56
#define PROF_H      40
#define VIS_Y       106
#define VIS_H       100
#define TOG_Y       218
#define TOG_ROW_H   44
#define IEQ_LBL_Y   358
#define IEQ_Y       376
#define IEQ_H       38
#define ADV_Y       426
#define ADV_ROW_H   32

/* Slider geometry (relative to content area) */
#define SL_X        300  /* slider left edge */
#define SL_W        220  /* slider width */
#define SL_VAL_X    530  /* value text x */
#define TOG_X       640  /* toggle switch x */
#define TOG_W       50
#define TOG_H       26

/* ── Control Pipe ─────────────────────────────────────────────────── */

#define CTRL_PIPE  "\\\\.\\pipe\\DolbyXCtrl"

static BOOL cp_read(HANDLE h, void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) { DWORD r = 0;
        if (!ReadFile(h, (BYTE*)buf+t, n-t, &r, NULL) || !r) return FALSE;
        t += r; } return TRUE;
}
static BOOL cp_write(HANDLE h, const void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) { DWORD w = 0;
        if (!WriteFile(h, (const BYTE*)buf+t, n-t, &w, NULL) || !w) return FALSE;
        t += w; } return TRUE;
}

static void ctrl_connect(DDPUI *ui) {
    if (ui->ctrl_pipe != INVALID_HANDLE_VALUE) return;
    for (int i = 0; i < 3; i++) {
        ui->ctrl_pipe = CreateFileA(CTRL_PIPE, GENERIC_READ|GENERIC_WRITE,
                                     0, NULL, OPEN_EXISTING, 0, NULL);
        if (ui->ctrl_pipe != INVALID_HANDLE_VALUE) break;
        if (GetLastError() == ERROR_PIPE_BUSY) WaitNamedPipeA(CTRL_PIPE, 1000);
        else break;
    }
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(ui->ctrl_pipe, &mode, NULL, NULL);
    DWORD magic = 0;
    if (!cp_read(ui->ctrl_pipe, &magic, 4) || magic != DDP_READY_MAGIC) {
        CloseHandle(ui->ctrl_pipe); ui->ctrl_pipe = INVALID_HANDLE_VALUE;
    }
}

static void ctrl_disconnect(DDPUI *ui) {
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    DWORD cmd = DDP_CMD_SHUTDOWN;
    cp_write(ui->ctrl_pipe, &cmd, 4);
    CloseHandle(ui->ctrl_pipe); ui->ctrl_pipe = INVALID_HANDLE_VALUE;
}

static void send_param(DDPUI *ui, int idx, int16_t val) {
    ui->params[idx] = val;
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) ctrl_connect(ui);
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    DWORD cmd = DDP_CMD_SET_PARAM;
    uint16_t pi = (uint16_t)idx;
    cp_write(ui->ctrl_pipe, &cmd, 4);
    cp_write(ui->ctrl_pipe, &pi, 2);
    cp_write(ui->ctrl_pipe, &val, 2);
    DWORD st = 0; cp_read(ui->ctrl_pipe, &st, 4);
}

static void send_profile(DDPUI *ui, int pid) {
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    ui->profile = pid;
    memcpy(ui->params, g_profiles[pid], sizeof(ui->params));
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) ctrl_connect(ui);
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    DWORD cmd = DDP_CMD_SET_PROFILE;
    DWORD id = (DWORD)pid;
    cp_write(ui->ctrl_pipe, &cmd, 4);
    cp_write(ui->ctrl_pipe, &id, 4);
    DWORD st = 0; cp_read(ui->ctrl_pipe, &st, 4);
}

/* ── Drawing Helpers ──────────────────────────────────────────────── */

static void fill(HDC dc, int x, int y, int w, int h, COLORREF c) {
    RECT r = {x, y, x+w, y+h};
    HBRUSH b = CreateSolidBrush(c);
    FillRect(dc, &r, b); DeleteObject(b);
}

static void rounded(HDC dc, int x, int y, int w, int h, int r,
                    COLORREF fc, COLORREF bc) {
    HBRUSH b = CreateSolidBrush(fc); HPEN p = CreatePen(PS_SOLID, 1, bc);
    HGDIOBJ ob = SelectObject(dc, b); HGDIOBJ op = SelectObject(dc, p);
    RoundRect(dc, x, y, x+w, y+h, r, r);
    SelectObject(dc, ob); SelectObject(dc, op);
    DeleteObject(b); DeleteObject(p);
}

static void text_at(HDC dc, int x, int y, const char *s, HFONT f, COLORREF c) {
    HFONT of = SelectObject(dc, f);
    SetTextColor(dc, c); SetBkMode(dc, TRANSPARENT);
    TextOutA(dc, x, y, s, (int)strlen(s));
    SelectObject(dc, of);
}

static void text_center(HDC dc, int x, int y, int w, int h,
                        const char *s, HFONT f, COLORREF c) {
    RECT r = {x, y, x+w, y+h};
    HFONT of = SelectObject(dc, f);
    SetTextColor(dc, c); SetBkMode(dc, TRANSPARENT);
    DrawTextA(dc, s, -1, &r, DT_CENTER|DT_VCENTER|DT_SINGLELINE);
    SelectObject(dc, of);
}

static void draw_slider(HDC dc, int x, int y, int w,
                        int val, int vmin, int vmax) {
    int th = 6, ty = y + 10;
    float t = (vmax > vmin) ? (float)(val-vmin)/(float)(vmax-vmin) : 0;
    int fw = (int)(w * t);

    rounded(dc, x, ty, w, th, 3, COL_SLIDER_BG, COL_SLIDER_BG);
    if (fw > 0) rounded(dc, x, ty, fw, th, 3, COL_ACCENT, COL_ACCENT);

    /* Thumb */
    int tx = x + fw - 7;
    if (tx < x) tx = x;
    HBRUSH b = CreateSolidBrush(COL_ACCENT_BR);
    HPEN p = CreatePen(PS_SOLID, 1, COL_ACCENT_BR);
    SelectObject(dc, b); SelectObject(dc, p);
    Ellipse(dc, tx, ty-5, tx+14, ty+th+5);
    DeleteObject(b); DeleteObject(p);
}

static void draw_toggle(HDC dc, int x, int y, int on) {
    COLORREF bg = on ? COL_GREEN : COL_BORDER;
    rounded(dc, x, y, TOG_W, TOG_H, TOG_H, bg, bg);
    int kx = on ? x + TOG_W - TOG_H + 3 : x + 3;
    HBRUSH b = CreateSolidBrush(RGB(255,255,255));
    HPEN p = CreatePen(PS_SOLID, 1, RGB(255,255,255));
    SelectObject(dc, b); SelectObject(dc, p);
    Ellipse(dc, kx, y+3, kx+TOG_H-6, y+TOG_H-3);
    DeleteObject(b); DeleteObject(p);
}

/* ── Main Paint ───────────────────────────────────────────────────── */

static void paint(DDPUI *ui) {
    HDC dc = ui->memdc;

    /* Background */
    fill(dc, 0, 0, UI_WIDTH, UI_HEIGHT, COL_BG);

    /* ── Header ───────────────────────────────────────────────────── */
    fill(dc, 0, HEADER_Y, UI_WIDTH, HEADER_H, COL_PANEL);
    {
        /* Power circle */
        COLORREF pc = ui->power ? COL_ACCENT : COL_BORDER;
        HBRUSH pb = CreateSolidBrush(COL_PANEL);
        HPEN pp = CreatePen(PS_SOLID, 2, pc);
        SelectObject(dc, pb); SelectObject(dc, pp);
        Ellipse(dc, 14, 10, 42, 38);
        DeleteObject(pb); DeleteObject(pp);
        /* Power icon line */
        HPEN pl = CreatePen(PS_SOLID, 2, pc);
        SelectObject(dc, pl);
        MoveToEx(dc, 28, 14, NULL); LineTo(dc, 28, 22);
        DeleteObject(pl);
    }
    text_at(dc, 52, 12, "DOLBY", ui->font_title, COL_ACCENT);
    text_at(dc, UI_WIDTH - 70, 16, "DolbyX", ui->font_small, COL_TEXT_DIM);

    /* ── Profile Buttons ──────────────────────────────────────────── */
    {
        static const char *names[] = {"Movie","Music","Game","Voice","Custom 1","Custom 2"};
        int gap = 6, bw = (CW - 5*gap) / 6;
        for (int i = 0; i < 6; i++) {
            int x = LM + i*(bw+gap);
            int active = (i == ui->profile);
            COLORREF bg = active ? COL_ACCENT : COL_SURFACE;
            COLORREF bd = active ? COL_ACCENT : COL_BORDER;
            COLORREF tc = active ? RGB(0,0,0) : COL_TEXT;
            rounded(dc, x, PROF_Y, bw, PROF_H, 8, bg, bd);
            text_center(dc, x, PROF_Y, bw, PROF_H, names[i], ui->font_normal, tc);
        }
    }

    /* ── Visualizer ───────────────────────────────────────────────── */
    {
        fill(dc, LM, VIS_Y, CW, VIS_H, COL_PANEL);
        int bands = 20, gap = 2;
        int bw = (CW - (bands+1)*gap) / bands;
        for (int i = 0; i < bands; i++) {
            int x = LM + gap + i*(bw+gap);
            float level = 0.15f + 0.4f * (0.5f + 0.5f * sinf(i*0.6f + ui->vis_phase));
            int bh = (int)(VIS_H * level);
            /* Gradient */
            for (int j = 0; j < bh; j++) {
                float t = (float)j / (VIS_H > 0 ? VIS_H : 1);
                COLORREF c = RGB(0, (int)(72+t*140), (int)(96+t*159));
                fill(dc, x, VIS_Y+VIS_H-1-j, bw, 1, c);
            }
        }
    }

    /* ── Toggle Rows ──────────────────────────────────────────────── */
    {
        struct { const char *label; int en_param; int amt_param; int vmin; int vmax; int on_val; }
        rows[] = {
            {"Volume Leveler",       DDP_PARAM_DVLE, DDP_PARAM_DVLA, 0, 10,  1},
            {"Dialogue Enhancer",    DDP_PARAM_DEON, DDP_PARAM_DEA,  0, 16,  1},
            {"Surround Virtualizer", DDP_PARAM_VDHE, DDP_PARAM_DHSB, 0, 192, 2},
        };
        for (int i = 0; i < 3; i++) {
            int y = TOG_Y + i * TOG_ROW_H;
            int is_on = (ui->params[rows[i].en_param] > 0);

            text_at(dc, LM, y+12, rows[i].label, ui->font_normal, COL_TEXT);

            draw_slider(dc, LM+SL_X, y+8, SL_W,
                        ui->params[rows[i].amt_param],
                        rows[i].vmin, rows[i].vmax);

            char vbuf[16];
            snprintf(vbuf, sizeof(vbuf), "%d", ui->params[rows[i].amt_param]);
            text_at(dc, LM+SL_VAL_X, y+12, vbuf, ui->font_small, COL_TEXT_DIM);

            draw_toggle(dc, LM+TOG_X, y+9, is_on);

            if (i < 2) {
                HPEN sep = CreatePen(PS_SOLID, 1, RGB(20,28,40));
                SelectObject(dc, sep);
                MoveToEx(dc, LM, y+TOG_ROW_H-1, NULL);
                LineTo(dc, LM+CW, y+TOG_ROW_H-1);
                DeleteObject(sep);
            }
        }
    }

    /* ── IEQ Mode ─────────────────────────────────────────────────── */
    {
        static const char *modes[] = {"Open","Rich","Focused","Manual"};
        const char *lbl = ui->ieq_mode == DDP_IEQ_MANUAL ? "Graphic EQ" : "Intelligent EQ";
        char buf[64]; snprintf(buf, sizeof(buf), "%s:  %s", lbl, modes[ui->ieq_mode]);
        text_at(dc, LM, IEQ_LBL_Y, buf, ui->font_small, COL_TEXT_DIM);

        int gap = 8, bw = (CW - 3*gap) / 4;
        for (int i = 0; i < 4; i++) {
            int x = LM + i*(bw+gap);
            int act = (i == ui->ieq_mode);
            rounded(dc, x, IEQ_Y, bw, IEQ_H, 8,
                    act ? RGB(0,30,50) : COL_SURFACE,
                    act ? COL_ACCENT : COL_BORDER);
            text_center(dc, x, IEQ_Y, bw, IEQ_H, modes[i],
                        ui->font_normal, act ? COL_ACCENT_BR : COL_TEXT);
        }
    }

    /* ── Advanced ─────────────────────────────────────────────────── */
    {
        text_at(dc, LM, ADV_Y, "Advanced", ui->font_small, COL_TEXT_DIM);
        int y1 = ADV_Y + 22;

        /* Pre-gain: mapped -12..0 → slider 0..12 */
        text_at(dc, LM, y1+6, "Pre-gain", ui->font_small, COL_TEXT_DIM);
        int pre_val = 12 + 6; /* current: -6 → mapped to 6 out of 12 */
        draw_slider(dc, LM+100, y1, 180, pre_val, 0, 12);
        text_at(dc, LM+290, y1+6, "-6 dB", ui->font_small, COL_TEXT_DIM);

        /* Post-gain: 0..12 */
        text_at(dc, LM+350, y1+6, "Post-gain", ui->font_small, COL_TEXT_DIM);
        draw_slider(dc, LM+450, y1, 150, 0, 0, 12);
        text_at(dc, LM+610, y1+6, "0 dB", ui->font_small, COL_TEXT_DIM);

        int y2 = y1 + ADV_ROW_H + 4;
        /* Vol Maximizer */
        text_at(dc, LM, y2+6, "Vol. Boost", ui->font_small, COL_TEXT_DIM);
        draw_slider(dc, LM+100, y2, 180, ui->params[DDP_PARAM_VMB], 0, 192);
        char vmbuf[16]; snprintf(vmbuf, sizeof(vmbuf), "%d", ui->params[DDP_PARAM_VMB]);
        text_at(dc, LM+290, y2+6, vmbuf, ui->font_small, COL_TEXT_DIM);

        /* Peak Limiter mode */
        text_at(dc, LM+350, y2+6, "Limiter", ui->font_small, COL_TEXT_DIM);
        static const char *plmodes[] = {"Off","Reg.Peak","Reg.Dist","Auto"};
        int plm = ui->params[DDP_PARAM_PLMD] - 1;
        if (plm < 0) plm = 0; if (plm > 3) plm = 3;
        text_at(dc, LM+450, y2+6, plmodes[plm], ui->font_small, COL_ACCENT);
    }

    ui->vis_phase += 0.1f;
}

/* ── Hit Testing ──────────────────────────────────────────────────── */

static int hit_profile(int mx, int my) {
    if (my < PROF_Y || my >= PROF_Y + PROF_H) return -1;
    int gap = 6, bw = (CW - 5*gap) / 6;
    int col = (mx - LM) / (bw + gap);
    if (col < 0 || col >= 6) return -1;
    return col;
}

static int hit_toggle(int mx, int my) {
    for (int i = 0; i < 3; i++) {
        int y = TOG_Y + i * TOG_ROW_H;
        int tx = LM + TOG_X;
        if (mx >= tx && mx <= tx+TOG_W && my >= y+6 && my <= y+6+TOG_H)
            return i;
    }
    return -1;
}

/* Returns slider row 0-2, or -1 */
static int hit_tog_slider(int mx, int my) {
    for (int i = 0; i < 3; i++) {
        int y = TOG_Y + i * TOG_ROW_H;
        if (mx >= LM+SL_X && mx <= LM+SL_X+SL_W && my >= y+4 && my <= y+4+30)
            return i;
    }
    return -1;
}

static int hit_ieq(int mx, int my) {
    if (my < IEQ_Y || my >= IEQ_Y + IEQ_H) return -1;
    int gap = 8, bw = (CW - 3*gap) / 4;
    int col = (mx - LM) / (bw + gap);
    return (col >= 0 && col < 4) ? col : -1;
}

static int slider_val(int mx, int sx, int sw, int vmin, int vmax) {
    float t = (float)(mx - sx) / (float)sw;
    if (t < 0) t = 0; if (t > 1) t = 1;
    return vmin + (int)(t * (vmax - vmin) + 0.5f);
}

/* ── Toggle/slider param mapping ──────────────────────────────────── */

static const int g_tog_en[]   = {DDP_PARAM_DVLE, DDP_PARAM_DEON, DDP_PARAM_VDHE};
static const int g_tog_amt[]  = {DDP_PARAM_DVLA, DDP_PARAM_DEA,  DDP_PARAM_DHSB};
static const int g_tog_min[]  = {0, 0, 0};
static const int g_tog_max[]  = {10, 16, 192};
static const int g_tog_onval[]= {1, 1, 2};  /* vdhe uses 2=AUTO */

/* ── Window Procedure ─────────────────────────────────────────────── */

static LRESULT CALLBACK ui_wndproc(HWND hwnd, UINT msg,
                                     WPARAM wp, LPARAM lp) {
    DDPUI *ui = (DDPUI *)GetWindowLongPtrA(hwnd, GWLP_USERDATA);

    switch (msg) {
    case WM_PAINT: {
        if (!ui) break;
        PAINTSTRUCT ps;
        HDC hdc = BeginPaint(hwnd, &ps);
        paint(ui);
        BitBlt(hdc, 0, 0, UI_WIDTH, UI_HEIGHT, ui->memdc, 0, 0, SRCCOPY);
        EndPaint(hwnd, &ps);
        return 0;
    }

    case WM_TIMER:
        if (ui) InvalidateRect(hwnd, NULL, FALSE);
        return 0;

    case WM_LBUTTONDOWN: {
        if (!ui) break;
        int mx = LOWORD(lp), my = HIWORD(lp);

        /* Power */
        if (mx >= 14 && mx <= 42 && my >= 10 && my <= 38) {
            ui->power = !ui->power;
            /* TODO: send enable/disable */
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Profile */
        int prof = hit_profile(mx, my);
        if (prof >= 0 && prof != ui->profile) {
            send_profile(ui, prof);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Toggle switch */
        int tog = hit_toggle(mx, my);
        if (tog >= 0) {
            int cur = ui->params[g_tog_en[tog]];
            int16_t nv = (cur > 0) ? 0 : g_tog_onval[tog];
            send_param(ui, g_tog_en[tog], nv);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Slider drag */
        int sl = hit_tog_slider(mx, my);
        if (sl >= 0) {
            ui->drag_slider = sl;
            ui->drag_param = g_tog_amt[sl];
            ui->drag_x0 = LM + SL_X;
            ui->drag_w = SL_W;
            ui->drag_min = g_tog_min[sl];
            ui->drag_max = g_tog_max[sl];
            SetCapture(hwnd);
            int v = slider_val(mx, ui->drag_x0, ui->drag_w,
                               ui->drag_min, ui->drag_max);
            send_param(ui, ui->drag_param, (int16_t)v);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* IEQ mode */
        int ieq = hit_ieq(mx, my);
        if (ieq >= 0 && ieq != ui->ieq_mode) {
            ui->ieq_mode = ieq;
            if (ieq == DDP_IEQ_MANUAL) {
                send_param(ui, DDP_PARAM_IEON, 0);
                send_param(ui, DDP_PARAM_GEON, 1);
            } else {
                send_param(ui, DDP_PARAM_GEON, 0);
                send_param(ui, DDP_PARAM_IEON, 1);
                /* Set IEQ amount to max for the preset to take effect */
                send_param(ui, DDP_PARAM_IEA, 10);
            }
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }
        break;
    }

    case WM_MOUSEMOVE: {
        if (!ui || ui->drag_slider < 0) break;
        int mx = LOWORD(lp);
        int v = slider_val(mx, ui->drag_x0, ui->drag_w,
                           ui->drag_min, ui->drag_max);
        send_param(ui, ui->drag_param, (int16_t)v);
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
        return 1;

    default: break;
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

/* ── Window Class ─────────────────────────────────────────────────── */

static const char *UI_CLASS = "DolbyXEditor";
static int g_registered = 0;

void ddpui_register_class(HINSTANCE hInst) {
    if (g_registered) return;
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = ui_wndproc;
    wc.hInstance = hInst;
    wc.lpszClassName = UI_CLASS;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.style = CS_DBLCLKS;
    RegisterClassA(&wc);
    g_registered = 1;
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

    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    memcpy(ui->params, g_profiles[DDP_PROFILE_MUSIC], sizeof(ui->params));

    ui->font_title  = CreateFontA(22, 0,0,0, FW_BOLD,   0,0,0, DEFAULT_CHARSET,
                                   0,0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_normal = CreateFontA(15, 0,0,0, FW_NORMAL, 0,0,0, DEFAULT_CHARSET,
                                   0,0, CLEARTYPE_QUALITY, 0, "Segoe UI");
    ui->font_small  = CreateFontA(12, 0,0,0, FW_NORMAL, 0,0,0, DEFAULT_CHARSET,
                                   0,0, CLEARTYPE_QUALITY, 0, "Segoe UI");

    HINSTANCE hInst = GetModuleHandle(NULL);
    ddpui_register_class(hInst);

    ui->hwnd = CreateWindowExA(0, UI_CLASS, "DolbyX",
        WS_CHILD | WS_VISIBLE, 0, 0, UI_WIDTH, UI_HEIGHT,
        parent, NULL, hInst, NULL);

    SetWindowLongPtrA(ui->hwnd, GWLP_USERDATA, (LONG_PTR)ui);

    HDC hdc = GetDC(ui->hwnd);
    ui->memdc = CreateCompatibleDC(hdc);
    ui->membmp = CreateCompatibleBitmap(hdc, UI_WIDTH, UI_HEIGHT);
    SelectObject(ui->memdc, ui->membmp);
    ReleaseDC(ui->hwnd, hdc);

    SetTimer(ui->hwnd, 1, 33, NULL);
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
    DestroyWindow(ui->hwnd);
    free(ui);
}

void ddpui_idle(DDPUI *ui) { (void)ui; }
