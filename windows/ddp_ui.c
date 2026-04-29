/*
 * ddp_ui.c — DolbyX VST Editor UI
 *
 * Clean GDI custom-drawn editor with Dolby-inspired dark theme.
 * Per-profile parameter persistence via INI config file.
 */

#include <windows.h>
#include <stdio.h>
#include <math.h>
#include "ddp_ui.h"

/* ── Layout (all in logical pixels, 720x560) ─────────────────────── */

#define LM  20
#define CW  (UI_WIDTH - 2 * LM)  /* 680 */

#define HEADER_H    48
#define PROF_Y      56
#define PROF_H      40
#define VIS_Y       108
#define VIS_H       100
#define TOG_Y       220
#define TOG_ROW_H   44
#define IEQ_LBL_Y   360
#define IEQ_Y       378
#define IEQ_H       38
#define ADV_Y       430
#define ADV_ROW_H   32

#define SL_X        300
#define SL_W        220
#define SL_VAL_X    530
#define TOG_X       640
#define TOG_W       50
#define TOG_H       26

/* ── Forward declarations ─────────────────────────────────────────── */

static void save_config(DDPUI *ui);
static void load_config(DDPUI *ui);
static void apply_current_profile(DDPUI *ui);

/* ── Control Pipe ─────────────────────────────────────────────────── */

#define CTRL_PIPE  "\\\\.\\pipe\\DolbyXCtrl"

static BOOL cp_read(HANDLE h, void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) { DWORD r = 0;
        if (!ReadFile(h,(BYTE*)buf+t,n-t,&r,NULL)||!r) return FALSE; t+=r; }
    return TRUE;
}

static BOOL cp_write(HANDLE h, const void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) { DWORD w = 0;
        if (!WriteFile(h,(const BYTE*)buf+t,n-t,&w,NULL)||!w) return FALSE; t+=w; }
    return TRUE;
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
    CUR_PARAMS(ui)[idx] = val;
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) ctrl_connect(ui);
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    DWORD cmd = DDP_CMD_SET_PARAM; uint16_t pi = (uint16_t)idx;
    cp_write(ui->ctrl_pipe, &cmd, 4);
    cp_write(ui->ctrl_pipe, &pi, 2);
    cp_write(ui->ctrl_pipe, &val, 2);
    DWORD st = 0; cp_read(ui->ctrl_pipe, &st, 4);
}

static void send_profile_switch(DDPUI *ui, int pid) {
    ui->profile = pid;
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) ctrl_connect(ui);
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    /* Send profile switch (resets to ds1-default.xml base) */
    DWORD cmd = DDP_CMD_SET_PROFILE;
    DWORD id = (DWORD)pid;
    cp_write(ui->ctrl_pipe, &cmd, 4);
    cp_write(ui->ctrl_pipe, &id, 4);
    DWORD st = 0; cp_read(ui->ctrl_pipe, &st, 4);
    /* Then apply our saved per-profile overrides */
    apply_current_profile(ui);
}

static void send_ieq_preset(DDPUI *ui, int preset_id) {
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) ctrl_connect(ui);
    if (ui->ctrl_pipe == INVALID_HANDLE_VALUE) return;
    DWORD cmd = DDP_CMD_SET_IEQ_PRESET;
    DWORD pid = (DWORD)preset_id;
    cp_write(ui->ctrl_pipe, &cmd, 4);
    cp_write(ui->ctrl_pipe, &pid, 4);
    DWORD st = 0; cp_read(ui->ctrl_pipe, &st, 4);
}

/* Apply saved per-profile param overrides on top of base profile */
static void apply_current_profile(DDPUI *ui) {
    int16_t *p = CUR_PARAMS(ui);
    for (int i = 0; i < DDP_PARAM_COUNT; i++) {
        if (i == DDP_PARAM_ENDP) continue;  /* don't change endpoint */
        send_param(ui, i, p[i]);
    }
    int ieq = CUR_IEQ(ui);
    if (ieq != DDP_IEQ_MANUAL && ieq >= 0 && ieq <= 2) {
        send_param(ui, DDP_PARAM_IEON, 1);
        send_param(ui, DDP_PARAM_IEA, 10);
        send_ieq_preset(ui, ieq);
    }
}

/* ── Config Persistence ───────────────────────────────────────────── */

static const char *g_profile_sections[] = {
    "Movie", "Music", "Game", "Voice", "Custom1", "Custom2"
};

static const char *g_param_keys[] = {
    "endp","vdhe","dhsb","dssb","dssf","ngon","dvla","dvle","dvme",
    "ieon","iea","deon","dea","ded","plmd","aoon","vmb","vmon","geon","plb"
};

static void save_config(DDPUI *ui) {
    if (!ui->config_path[0]) return;
    char val[32];

    /* Save active profile */
    snprintf(val, sizeof(val), "%d", ui->profile);
    WritePrivateProfileStringA("DolbyX", "active_profile", val, ui->config_path);

    /* Save each profile's params */
    for (int p = 0; p < DDP_PROFILE_COUNT; p++) {
        const char *sec = g_profile_sections[p];
        for (int i = 0; i < DDP_PARAM_COUNT; i++) {
            snprintf(val, sizeof(val), "%d", ui->profiles[p].params[i]);
            WritePrivateProfileStringA(sec, g_param_keys[i], val, ui->config_path);
        }
        snprintf(val, sizeof(val), "%d", ui->profiles[p].ieq_mode);
        WritePrivateProfileStringA(sec, "ieq_mode", val, ui->config_path);
    }
}

static void load_config(DDPUI *ui) {
    if (!ui->config_path[0]) return;

    /* Load active profile */
    ui->profile = GetPrivateProfileIntA("DolbyX", "active_profile",
                                         DDP_PROFILE_MUSIC, ui->config_path);
    if (ui->profile < 0 || ui->profile >= DDP_PROFILE_COUNT)
        ui->profile = DDP_PROFILE_MUSIC;

    /* Load each profile's params (falls back to defaults if file missing) */
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    for (int p = 0; p < DDP_PROFILE_COUNT; p++) {
        const char *sec = g_profile_sections[p];
        for (int i = 0; i < DDP_PARAM_COUNT; i++) {
            ui->profiles[p].params[i] = (int16_t)GetPrivateProfileIntA(
                sec, g_param_keys[i], g_profiles[p][i], ui->config_path);
        }
        ui->profiles[p].ieq_mode = GetPrivateProfileIntA(
            sec, "ieq_mode", DDP_IEQ_MANUAL, ui->config_path);
    }
}

/* ── Drawing Helpers ──────────────────────────────────────────────── */

static void fill(HDC dc, int x, int y, int w, int h, COLORREF c) {
    RECT r = {x, y, x+w, y+h};
    HBRUSH b = CreateSolidBrush(c); FillRect(dc, &r, b); DeleteObject(b);
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
    int tx = x + fw - 7; if (tx < x) tx = x;
    HBRUSH b = CreateSolidBrush(COL_ACCENT_BR);
    HPEN p = CreatePen(PS_SOLID, 1, COL_ACCENT_BR);
    SelectObject(dc, b); SelectObject(dc, p);
    Ellipse(dc, tx, ty-5, tx+14, ty+th+5);
    DeleteObject(b); DeleteObject(p);
}

static void draw_toggle(HDC dc, int x, int y, int on) {
    rounded(dc, x, y, TOG_W, TOG_H, TOG_H, on ? COL_GREEN : COL_BORDER,
            on ? COL_GREEN : COL_BORDER);
    int kx = on ? x + TOG_W - TOG_H + 3 : x + 3;
    HBRUSH b = CreateSolidBrush(RGB(255,255,255));
    HPEN p = CreatePen(PS_SOLID, 1, RGB(255,255,255));
    SelectObject(dc, b); SelectObject(dc, p);
    Ellipse(dc, kx, y+3, kx+TOG_H-6, y+TOG_H-3);
    DeleteObject(b); DeleteObject(p);
}

/* ── Paint ────────────────────────────────────────────────────────── */

static void paint(DDPUI *ui) {
    HDC dc = ui->memdc;
    int16_t *P = CUR_PARAMS(ui);

    fill(dc, 0, 0, UI_WIDTH, UI_HEIGHT, COL_BG);

    /* Header */
    fill(dc, 0, 0, UI_WIDTH, HEADER_H, COL_PANEL);
    {
        COLORREF pc = ui->power ? COL_ACCENT : COL_BORDER;
        HBRUSH pb = CreateSolidBrush(COL_PANEL);
        HPEN pp = CreatePen(PS_SOLID, 2, pc);
        SelectObject(dc, pb); SelectObject(dc, pp);
        Ellipse(dc, 14, 10, 42, 38);
        DeleteObject(pb); DeleteObject(pp);
        HPEN pl = CreatePen(PS_SOLID, 2, pc);
        SelectObject(dc, pl);
        MoveToEx(dc, 28, 14, NULL); LineTo(dc, 28, 22);
        DeleteObject(pl);
    }
    text_at(dc, 52, 12, "DOLBY", ui->font_title, COL_ACCENT);
    text_at(dc, UI_WIDTH - 70, 16, "DolbyX", ui->font_small, COL_TEXT_DIM);

    /* Profile buttons */
    {
        static const char *names[] = {"Movie","Music","Game","Voice","Custom 1","Custom 2"};
        int gap = 6, bw = (CW - 5*gap) / 6;
        for (int i = 0; i < 6; i++) {
            int x = LM + i*(bw+gap);
            int act = (i == ui->profile);
            rounded(dc, x, PROF_Y, bw, PROF_H, 8,
                    act ? COL_ACCENT : COL_SURFACE,
                    act ? COL_ACCENT : COL_BORDER);
            text_center(dc, x, PROF_Y, bw, PROF_H, names[i], ui->font_normal,
                        act ? RGB(0,0,0) : COL_TEXT);
        }
        /* Reset button */
        rounded(dc, UI_WIDTH-LM-52, PROF_Y+6, 48, PROF_H-12, 6,
                COL_SURFACE, COL_BORDER);
        text_center(dc, UI_WIDTH-LM-52, PROF_Y+6, 48, PROF_H-12,
                    "Reset", ui->font_small, COL_TEXT_DIM);
    }

    /* Visualizer */
    {
        fill(dc, LM, VIS_Y, CW, VIS_H, COL_PANEL);
        int bands = 20, gap = 2, bw = (CW - (bands+1)*gap) / bands;
        for (int i = 0; i < bands; i++) {
            int x = LM + gap + i*(bw+gap);
            float level = 0.15f + 0.4f * (0.5f + 0.5f*sinf(i*0.6f + ui->vis_phase));
            int bh = (int)(VIS_H * level);
            for (int j = 0; j < bh; j++) {
                float t = (float)j / VIS_H;
                fill(dc, x, VIS_Y+VIS_H-1-j, bw, 1,
                     RGB(0, (int)(72+t*140), (int)(96+t*159)));
            }
        }
    }

    /* Toggle rows */
    {
        struct { const char *label; int en; int amt; int vmin; int vmax; }
        rows[] = {
            {"Volume Leveler",       DDP_PARAM_DVLE, DDP_PARAM_DVLA, 0, 10},
            {"Dialogue Enhancer",    DDP_PARAM_DEON, DDP_PARAM_DEA,  0, 16},
            {"Surround Virtualizer", DDP_PARAM_VDHE, DDP_PARAM_DHSB, 0, 192},
        };
        for (int i = 0; i < 3; i++) {
            int y = TOG_Y + i * TOG_ROW_H;
            text_at(dc, LM, y+12, rows[i].label, ui->font_normal, COL_TEXT);
            draw_slider(dc, LM+SL_X, y+8, SL_W, P[rows[i].amt], rows[i].vmin, rows[i].vmax);
            char vb[16]; snprintf(vb, sizeof(vb), "%d", P[rows[i].amt]);
            text_at(dc, LM+SL_VAL_X, y+12, vb, ui->font_small, COL_TEXT_DIM);
            draw_toggle(dc, LM+TOG_X, y+9, P[rows[i].en] > 0);
            if (i < 2) {
                HPEN s = CreatePen(PS_SOLID, 1, RGB(20,28,40));
                SelectObject(dc, s);
                MoveToEx(dc, LM, y+TOG_ROW_H-1, NULL);
                LineTo(dc, LM+CW, y+TOG_ROW_H-1);
                DeleteObject(s);
            }
        }
    }

    /* IEQ mode */
    {
        static const char *modes[] = {"Open","Rich","Focused","Manual"};
        int ieq = CUR_IEQ(ui);
        const char *lbl = (ieq == DDP_IEQ_MANUAL) ? "Graphic EQ" : "Intelligent EQ";
        char buf[64]; snprintf(buf, sizeof(buf), "%s:  %s", lbl, modes[ieq]);
        text_at(dc, LM, IEQ_LBL_Y, buf, ui->font_small, COL_TEXT_DIM);

        int gap = 8, bw = (CW - 3*gap) / 4;
        for (int i = 0; i < 4; i++) {
            int x = LM + i*(bw+gap), act = (i == ieq);
            rounded(dc, x, IEQ_Y, bw, IEQ_H, 8,
                    act ? RGB(0,30,50) : COL_SURFACE,
                    act ? COL_ACCENT : COL_BORDER);
            text_center(dc, x, IEQ_Y, bw, IEQ_H, modes[i], ui->font_normal,
                        act ? COL_ACCENT_BR : COL_TEXT);
        }
    }

    /* Advanced section */
    {
        text_at(dc, LM, ADV_Y, "Advanced", ui->font_small, COL_TEXT_DIM);
        int y1 = ADV_Y + 22;

        text_at(dc, LM, y1+6, "Vol. Boost", ui->font_small, COL_TEXT_DIM);
        draw_slider(dc, LM+100, y1, 220, P[DDP_PARAM_VMB], 0, 192);
        char vb[16]; snprintf(vb, sizeof(vb), "%d (+%.1fdB)",
                              P[DDP_PARAM_VMB], P[DDP_PARAM_VMB] / 20.0f);
        text_at(dc, LM+330, y1+6, vb, ui->font_small, COL_TEXT_DIM);

        static const char *plm[] = {"Off","Reg.Peak","Reg.Dist","Auto"};
        int pm = P[DDP_PARAM_PLMD] - 1;
        if (pm < 0) pm = 0; if (pm > 3) pm = 3;
        text_at(dc, LM+480, y1+6, "Limiter:", ui->font_small, COL_TEXT_DIM);
        text_at(dc, LM+540, y1+6, plm[pm], ui->font_small, COL_ACCENT);

        int y2 = y1 + ADV_ROW_H;
        /* Next Gen Surround */
        text_at(dc, LM, y2+6, "Surround", ui->font_small, COL_TEXT_DIM);
        static const char *ngm[] = {"Off","On","Auto"};
        int ng = P[DDP_PARAM_NGON]; if (ng < 0) ng = 0; if (ng > 2) ng = 2;
        text_at(dc, LM+80, y2+6, ngm[ng], ui->font_small, COL_ACCENT);

        text_at(dc, LM+160, y2+6, "Audio Opt:", ui->font_small, COL_TEXT_DIM);
        int ao = P[DDP_PARAM_AOON]; if (ao < 0) ao = 0; if (ao > 2) ao = 2;
        text_at(dc, LM+250, y2+6, ngm[ao], ui->font_small, COL_ACCENT);

        text_at(dc, LM+340, y2+6, "Vol.Max:", ui->font_small, COL_TEXT_DIM);
        static const char *vmm[] = {"Off","On","Auto"};
        int vm = P[DDP_PARAM_VMON]; if (vm < 0) vm = 0; if (vm > 2) vm = 2;
        text_at(dc, LM+420, y2+6, vmm[vm], ui->font_small, COL_ACCENT);
    }

    ui->vis_phase += 0.1f;
}

/* ── Hit Testing ──────────────────────────────────────────────────── */

static int hit_profile(int mx, int my) {
    if (my < PROF_Y || my >= PROF_Y + PROF_H) return -1;
    int gap = 6, bw = (CW - 5*gap) / 6;
    int col = (mx - LM) / (bw + gap);
    return (col >= 0 && col < 6) ? col : -1;
}

static int hit_reset(int mx, int my) {
    return (mx >= UI_WIDTH-LM-52 && mx <= UI_WIDTH-LM &&
            my >= PROF_Y+6 && my <= PROF_Y+PROF_H-6);
}

static int hit_toggle(int mx, int my) {
    for (int i = 0; i < 3; i++) {
        int y = TOG_Y + i * TOG_ROW_H, tx = LM + TOG_X;
        if (mx >= tx && mx <= tx+TOG_W && my >= y+6 && my <= y+6+TOG_H)
            return i;
    }
    return -1;
}

static int hit_tog_slider(int mx, int my) {
    for (int i = 0; i < 3; i++) {
        int y = TOG_Y + i * TOG_ROW_H;
        if (mx >= LM+SL_X && mx <= LM+SL_X+SL_W && my >= y+4 && my <= y+4+30)
            return i;
    }
    return -1;
}

static int hit_adv_slider(int mx, int my) {
    int y1 = ADV_Y + 22;
    if (mx >= LM+100 && mx <= LM+320 && my >= y1 && my <= y1+26) return 12; /* VMB */
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

/* ── Toggle/slider mappings ───────────────────────────────────────── */

static const int g_tog_en[]    = {DDP_PARAM_DVLE, DDP_PARAM_DEON, DDP_PARAM_VDHE};
static const int g_tog_amt[]   = {DDP_PARAM_DVLA, DDP_PARAM_DEA,  DDP_PARAM_DHSB};
static const int g_tog_min[]   = {0, 0, 0};
static const int g_tog_max[]   = {10, 16, 192};
static const int g_tog_onval[] = {1, 1, 2};

/* ── Window Procedure ─────────────────────────────────────────────── */

static LRESULT CALLBACK ui_wndproc(HWND hwnd, UINT msg,
                                     WPARAM wp, LPARAM lp) {
    DDPUI *ui = (DDPUI *)GetWindowLongPtrA(hwnd, GWLP_USERDATA);

    switch (msg) {
    case WM_PAINT: {
        if (!ui) break;
        PAINTSTRUCT ps; HDC hdc = BeginPaint(hwnd, &ps);
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
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Reset */
        if (hit_reset(mx, my)) {
            extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
            memcpy(CUR_PARAMS(ui), g_profiles[ui->profile],
                   sizeof(int16_t) * DDP_PARAM_COUNT);
            CUR_IEQ(ui) = DDP_IEQ_MANUAL;
            send_profile_switch(ui, ui->profile);
            save_config(ui);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Profile */
        int prof = hit_profile(mx, my);
        if (prof >= 0 && prof != ui->profile) {
            send_profile_switch(ui, prof);
            save_config(ui);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Toggle */
        int tog = hit_toggle(mx, my);
        if (tog >= 0) {
            int cur = CUR_PARAMS(ui)[g_tog_en[tog]];
            send_param(ui, g_tog_en[tog], (cur > 0) ? 0 : g_tog_onval[tog]);
            save_config(ui);
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Toggle slider */
        int sl = hit_tog_slider(mx, my);
        if (sl >= 0) {
            ui->drag_slider = sl;
            ui->drag_param = g_tog_amt[sl];
            ui->drag_x0 = LM+SL_X; ui->drag_w = SL_W;
            ui->drag_min = g_tog_min[sl]; ui->drag_max = g_tog_max[sl];
            SetCapture(hwnd);
            send_param(ui, ui->drag_param,
                (int16_t)slider_val(mx, ui->drag_x0, ui->drag_w,
                                     ui->drag_min, ui->drag_max));
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* Advanced VMB slider */
        int adv = hit_adv_slider(mx, my);
        if (adv == 12) {
            ui->drag_slider = 12;
            ui->drag_param = DDP_PARAM_VMB;
            ui->drag_x0 = LM+100; ui->drag_w = 220;
            ui->drag_min = 0; ui->drag_max = 192;
            SetCapture(hwnd);
            send_param(ui, DDP_PARAM_VMB,
                (int16_t)slider_val(mx, LM+100, 220, 0, 192));
            InvalidateRect(hwnd, NULL, FALSE);
            return 0;
        }

        /* IEQ mode */
        int ieq = hit_ieq(mx, my);
        if (ieq >= 0 && ieq != CUR_IEQ(ui)) {
            CUR_IEQ(ui) = ieq;
            if (ieq == DDP_IEQ_MANUAL) {
                send_param(ui, DDP_PARAM_IEON, 0);
                send_param(ui, DDP_PARAM_GEON, 1);
            } else {
                send_param(ui, DDP_PARAM_GEON, 0);
                send_param(ui, DDP_PARAM_IEON, 1);
                send_param(ui, DDP_PARAM_IEA, 10);
                send_ieq_preset(ui, ieq);
            }
            save_config(ui);
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
            save_config(ui);
        }
        return 0;

    case WM_ERASEBKGND: return 1;
    default: break;
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

/* ── Class Registration ───────────────────────────────────────────── */

static const char *UI_CLASS = "DolbyXEditor";
static int g_registered = 0;

void ddpui_register_class(HINSTANCE hInst) {
    if (g_registered) return;
    WNDCLASSA wc = {0};
    wc.lpfnWndProc = ui_wndproc;
    wc.hInstance = hInst;
    wc.lpszClassName = UI_CLASS;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    RegisterClassA(&wc);
    g_registered = 1;
}

/* ── Create / Destroy ─────────────────────────────────────────────── */

DDPUI *ddpui_create(HWND parent, const char *dll_dir) {
    DDPUI *ui = (DDPUI *)calloc(1, sizeof(DDPUI));
    if (!ui) return NULL;

    ui->ctrl_pipe = INVALID_HANDLE_VALUE;
    ui->power = 1;
    ui->profile = DDP_PROFILE_MUSIC;
    ui->drag_slider = -1;

    /* Config path */
    if (dll_dir && dll_dir[0])
        snprintf(ui->config_path, sizeof(ui->config_path),
                 "%s\\DolbyX.ini", dll_dir);

    /* Initialize all profiles from defaults */
    extern const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT];
    for (int p = 0; p < DDP_PROFILE_COUNT; p++) {
        memcpy(ui->profiles[p].params, g_profiles[p],
               sizeof(int16_t) * DDP_PARAM_COUNT);
        ui->profiles[p].ieq_mode = DDP_IEQ_MANUAL;
    }

    /* Load saved state (overwrites defaults where config exists) */
    load_config(ui);

    /* Fonts */
    ui->font_title  = CreateFontA(22,0,0,0,FW_BOLD,  0,0,0,DEFAULT_CHARSET,
                                   0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
    ui->font_normal = CreateFontA(15,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,
                                   0,0,CLEARTYPE_QUALITY,0,"Segoe UI");
    ui->font_small  = CreateFontA(12,0,0,0,FW_NORMAL,0,0,0,DEFAULT_CHARSET,
                                   0,0,CLEARTYPE_QUALITY,0,"Segoe UI");

    HINSTANCE hInst = GetModuleHandle(NULL);
    ddpui_register_class(hInst);
    ui->hwnd = CreateWindowExA(0, UI_CLASS, "DolbyX",
        WS_CHILD|WS_VISIBLE, 0, 0, UI_WIDTH, UI_HEIGHT,
        parent, NULL, hInst, NULL);
    SetWindowLongPtrA(ui->hwnd, GWLP_USERDATA, (LONG_PTR)ui);

    HDC hdc = GetDC(ui->hwnd);
    ui->memdc = CreateCompatibleDC(hdc);
    ui->membmp = CreateCompatibleBitmap(hdc, UI_WIDTH, UI_HEIGHT);
    SelectObject(ui->memdc, ui->membmp);
    ReleaseDC(ui->hwnd, hdc);

    SetTimer(ui->hwnd, 1, 33, NULL);

    /* Connect and apply saved profile state */
    ctrl_connect(ui);
    if (ui->ctrl_pipe != INVALID_HANDLE_VALUE) {
        send_profile_switch(ui, ui->profile);
    }

    InvalidateRect(ui->hwnd, NULL, FALSE);
    return ui;
}

void ddpui_destroy(DDPUI *ui) {
    if (!ui) return;
    save_config(ui);
    KillTimer(ui->hwnd, 1);
    ctrl_disconnect(ui);
    DeleteDC(ui->memdc); DeleteObject(ui->membmp);
    DeleteObject(ui->font_title); DeleteObject(ui->font_normal);
    DeleteObject(ui->font_small);
    DestroyWindow(ui->hwnd);
    free(ui);
}

void ddpui_idle(DDPUI *ui) { (void)ui; }
