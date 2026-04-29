/*
 * ddp_vst.c — DolbyX VST2 Plugin with Editor UI
 *
 * Named pipe audio bridge + GDI editor window for live parameter control.
 * Connects to \\.\pipe\DolbyX served by dolbyx-bridge.exe.
 *
 * Build:
 *   x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll \
 *     ddp_vst.c ddp_ui.c -static -lgdi32 -lmsimg32 -lcomdlg32
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"
#include "ddp_protocol.h"
#include "ddp_ui.h"

/* ── Configuration ────────────────────────────────────────────────── */

#define DDP_UNIQUE_ID       0x44445031
#define DDP_VERSION         200
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512
#define MAX_FRAMES          131072
#define PIPE_NAME           "\\\\.\\pipe\\DolbyX"

/* ── Profile Data (must match ddp_processor.c) ────────────────────── */

const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT] = {
    [DDP_PROFILE_MOVIE] = {
        2, 2, 96, 96, 200, 2, 7, 0, 0, 0, 10, 1, 3, 0, 4, 2, 144, 0, 0, 0
    },
    [DDP_PROFILE_MUSIC] = {
        2, 2, 48, 0, 200, 2, 4, 0, 0, 0, 10, 1, 2, 0, 4, 2, 144, 0, 0, 0
    },
    [DDP_PROFILE_GAME] = {
        2, 2, 0, 0, 200, 2, 0, 1, 0, 0, 10, 0, 7, 0, 4, 2, 144, 2, 0, 0
    },
    [DDP_PROFILE_VOICE] = {
        2, 0, 0, 0, 200, 2, 0, 0, 0, 0, 10, 1, 10, 0, 4, 2, 144, 0, 0, 0
    },
    [DDP_PROFILE_USER1] = {
        2, 0, 48, 48, 200, 2, 5, 0, 0, 0, 10, 0, 7, 0, 4, 2, 144, 2, 0, 0
    },
    [DDP_PROFILE_USER2] = {
        2, 0, 48, 48, 200, 2, 5, 0, 0, 0, 10, 0, 7, 0, 4, 2, 144, 2, 0, 0
    },
};

/* ── Plugin State ─────────────────────────────────────────────────── */

typedef struct {
    HANDLE          pipe;
    int16_t        *pcm_buf;
    int             connected;
    int             bypass;
    int             block_count;
    float           sample_rate;
    char            dll_dir[512];
    FILE           *logfp;
    audioMasterCallback master;

    /* Editor */
    DDPUI          *editor;
    ERect           editor_rect;
} DDPState;

/* ── Logging ──────────────────────────────────────────────────────── */

static void open_log(DDPState *st) {
    char p[600];
    snprintf(p, sizeof(p), "%s\\DolbyDDP.log", st->dll_dir);
    st->logfp = fopen(p, "a");
    if (!st->logfp) st->logfp = fopen("C:\\Users\\Public\\DolbyDDP.log", "a");
    if (!st->logfp) {
        char t[MAX_PATH]; GetTempPathA(sizeof(t), t);
        snprintf(p, sizeof(p), "%sDolbyDDP.log", t);
        st->logfp = fopen(p, "a");
    }
}

static void logf_(DDPState *st, const char *fmt, ...) {
    if (!st || !st->logfp) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(st->logfp, "[%02d:%02d:%02d.%03d PID:%lu] ",
            t.wHour, t.wMinute, t.wSecond, t.wMilliseconds,
            (unsigned long)GetCurrentProcessId());
    va_list a; va_start(a, fmt); vfprintf(st->logfp, fmt, a); va_end(a);
    fflush(st->logfp);
}

/* ── Pipe I/O ─────────────────────────────────────────────────────── */

static BOOL p_read(HANDLE h, void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) {
        DWORD r = 0;
        if (!ReadFile(h, (BYTE *)buf + t, n - t, &r, NULL) || r == 0)
            return FALSE;
        t += r;
    }
    return TRUE;
}

static BOOL p_write(HANDLE h, const void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) {
        DWORD w = 0;
        if (!WriteFile(h, (const BYTE *)buf + t, n - t, &w, NULL) || w == 0)
            return FALSE;
        t += w;
    }
    return TRUE;
}

static void get_dll_dir(char *buf, size_t sz) {
    HMODULE hm = NULL;
    GetModuleHandleExA(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        (LPCSTR)&get_dll_dir, &hm);
    GetModuleFileNameA(hm, buf, (DWORD)sz);
    char *p = strrchr(buf, '\\');
    if (p) *p = '\0';
}

/* ── Bridge Connection ────────────────────────────────────────────── */

static int connect_bridge(DDPState *st) {
    if (st->connected) return 0;

    for (int attempt = 0; attempt < 5; attempt++) {
        st->pipe = CreateFileA(PIPE_NAME, GENERIC_READ | GENERIC_WRITE,
                               0, NULL, OPEN_EXISTING, 0, NULL);
        if (st->pipe != INVALID_HANDLE_VALUE) break;
        DWORD err = GetLastError();
        if (err == ERROR_PIPE_BUSY) {
            if (WaitNamedPipeA(PIPE_NAME, 2000)) continue;
        }
        logf_(st, "Pipe open failed: err=%lu (attempt %d)\n", err, attempt + 1);
        return -1;
    }

    if (st->pipe == INVALID_HANDLE_VALUE) return -1;

    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(st->pipe, &mode, NULL, NULL);

    DWORD magic = 0;
    if (!p_read(st->pipe, &magic, 4) || magic != DDP_READY_MAGIC) {
        logf_(st, "Bad magic: 0x%08X\n", magic);
        CloseHandle(st->pipe); st->pipe = INVALID_HANDLE_VALUE;
        return -1;
    }

    logf_(st, "Connected to bridge\n");
    st->connected = 1; st->bypass = 0; st->block_count = 0;
    return 0;
}

static void disconnect_bridge(DDPState *st) {
    if (!st->connected) return;
    DWORD cmd = DDP_CMD_SHUTDOWN;
    p_write(st->pipe, &cmd, 4);
    CloseHandle(st->pipe); st->pipe = INVALID_HANDLE_VALUE;
    st->connected = 0;
    logf_(st, "Disconnected after %d blocks\n", st->block_count);
}

/* ── processReplacing ────────────────────────────────────────────── */

static void ddp_processReplacing(struct AEffect *effect,
                                  float **inputs, float **outputs,
                                  int32_t sampleFrames) {
    DDPState *st = (DDPState *)effect->object;

    if (!st->connected && !st->bypass) {
        if (connect_bridge(st) != 0) { st->bypass = 1; }
    }

    if (!st->connected || st->bypass || sampleFrames <= 0) {
        if (inputs[0] != outputs[0])
            memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        if (inputs[1] != outputs[1])
            memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    /* Drain pending UI commands before processing audio */

    int frames = (sampleFrames > MAX_FRAMES) ? MAX_FRAMES : sampleFrames;
    DWORD pcm_bytes = frames * 2 * sizeof(int16_t);

    for (int i = 0; i < frames; i++) {
        float l = inputs[0][i], r = inputs[1][i];
        if (l >  1.0f) l =  1.0f; if (l < -1.0f) l = -1.0f;
        if (r >  1.0f) r =  1.0f; if (r < -1.0f) r = -1.0f;
        st->pcm_buf[i * 2]     = (int16_t)(l * 32767.0f);
        st->pcm_buf[i * 2 + 1] = (int16_t)(r * 32767.0f);
    }

    DWORD fc = (DWORD)frames;
    if (!p_write(st->pipe, &fc, 4) ||
        !p_write(st->pipe, st->pcm_buf, pcm_bytes)) {
        st->connected = 0; st->bypass = 1;
        memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    if (!p_read(st->pipe, st->pcm_buf, pcm_bytes)) {
        st->connected = 0; st->bypass = 1;
        memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    const float scale = 1.0f / 32767.0f;
    for (int i = 0; i < frames; i++) {
        outputs[0][i] = (float)st->pcm_buf[i * 2]     * scale;
        outputs[1][i] = (float)st->pcm_buf[i * 2 + 1] * scale;
    }
    for (int i = frames; i < sampleFrames; i++) {
        outputs[0][i] = 0.0f; outputs[1][i] = 0.0f;
    }

    st->block_count++;
    if (st->block_count <= 3 || st->block_count % 5000 == 0)
        logf_(st, "Block %d: %d frames\n", st->block_count, frames);
}

/* ── Parameters ───────────────────────────────────────────────────── */

static float ddp_getParam(struct AEffect *e, int32_t i) {
    DDPState *st = (DDPState *)e->object;
    return (i == 0 && st) ? (st->bypass ? 1.0f : 0.0f) : 0.0f;
}

static void ddp_setParam(struct AEffect *e, int32_t i, float v) {
    DDPState *st = (DDPState *)e->object;
    if (i == 0 && st) {
        if (v > 0.5f && !st->bypass) disconnect_bridge(st);
        st->bypass = (v > 0.5f) ? 1 : 0;
    }
}

/* ── Dispatcher ───────────────────────────────────────────────────── */

static intptr_t ddp_dispatch(struct AEffect *effect,
    int32_t opcode, int32_t index, intptr_t value, void *ptr, float opt) {

    DDPState *st = (DDPState *)effect->object;

    switch (opcode) {
    case effOpen: {
        get_dll_dir(st->dll_dir, sizeof(st->dll_dir));
        open_log(st);
        char exe[MAX_PATH] = {0};
        GetModuleFileNameA(NULL, exe, sizeof(exe));
        logf_(st, "\n===== DolbyX v2.0 opened =====\n");
        logf_(st, "Host: %s\n", exe);
        st->pcm_buf = (int16_t *)malloc(MAX_FRAMES * 2 * sizeof(int16_t));
        if (connect_bridge(st) != 0)
            logf_(st, "Bridge not running\n");
        return 0;
    }

    case effClose:
        logf_(st, "effClose: %d blocks\n", st->block_count);
        disconnect_bridge(st);
        if (st->logfp) fclose(st->logfp);
        free(st->pcm_buf);
        free(st);
        effect->object = NULL;
        return 0;

    /* ── Editor ─────────────────────────────────────────────────── */

    case effEditGetRect: {
        st->editor_rect.left = 0;
        st->editor_rect.top = 0;
        st->editor_rect.right = UI_WIDTH;
        st->editor_rect.bottom = UI_HEIGHT;
        *(ERect **)ptr = &st->editor_rect;
        return 1;
    }

    case effEditOpen: {
        HWND parent = (HWND)ptr;
        logf_(st, "Editor open (parent=%p)\n", parent);
        st->editor = ddpui_create(parent, st->dll_dir);
        if (!st->editor)
            logf_(st, "Editor create FAILED\n");
        return st->editor ? 1 : 0;
    }

    case effEditClose:
        logf_(st, "Editor close\n");
        ddpui_destroy(st->editor);
        st->editor = NULL;
        return 0;

    case effEditIdle:
        ddpui_idle(st->editor);
        return 0;

    /* ── Standard ───────────────────────────────────────────────── */

    case effSetSampleRate:
        if (st) { st->sample_rate = opt; logf_(st, "Rate: %.0f\n", opt); }
        return 0;
    case effSetBlockSize:
        if (st) logf_(st, "BlockSize: %d\n", (int)value);
        return 0;
    case effMainsChanged:
        if (st) {
            logf_(st, "MainsChanged: %d\n", (int)value);
            if (value == 1 && !st->connected && !st->bypass) {
                st->bypass = 0;
                connect_bridge(st);
            }
        }
        return 0;

    case effGetEffectName:    strcpy((char *)ptr, "DolbyX DDP");          return 1;
    case effGetVendorString:  strcpy((char *)ptr, "DolbyX");              return 1;
    case effGetProductString: strcpy((char *)ptr, "Dolby Digital Plus");  return 1;
    case effGetVendorVersion: return DDP_VERSION;
    case effGetVstVersion:    return kVstVersion;
    case effGetPlugCategory:  return kPlugCategEffect;

    case effCanDo:
        if (ptr && !strcmp((char *)ptr, "receiveVstEvents"))     return -1;
        if (ptr && !strcmp((char *)ptr, "receiveVstMidiEvent"))  return -1;
        return 0;

    case effGetParamName: case effGetParamLabel: case effGetParamDisplay:
        if (index == 0 && ptr) {
            strcpy((char *)ptr, opcode == effGetParamDisplay
                ? (st->bypass ? "ON" : "OFF") : "Bypass");
            return 1;
        }
        return 0;

    default:
        return 0;
    }
}

/* ── Entry Point ──────────────────────────────────────────────────── */

#ifdef __cplusplus
extern "C" {
#endif

VST_EXPORT struct AEffect *VSTPluginMain(audioMasterCallback audioMaster) {
    if (!audioMaster) return NULL;
    if (!audioMaster(NULL, audioMasterVersion, 0, 0, NULL, 0.0f)) return NULL;

    DDPState *st = (DDPState *)calloc(1, sizeof(DDPState));
    if (!st) return NULL;
    st->master = audioMaster;
    st->sample_rate = 48000.0f;
    st->pipe = INVALID_HANDLE_VALUE;

    struct AEffect *e = (struct AEffect *)calloc(1, sizeof(struct AEffect));
    if (!e) { free(st); return NULL; }

    e->magic            = 0x56737450;
    e->dispatcher       = ddp_dispatch;
    e->setParameter     = ddp_setParam;
    e->getParameter     = ddp_getParam;
    e->numPrograms      = 1;
    e->numParams        = 1;
    e->numInputs        = DDP_NUM_CHANNELS;
    e->numOutputs       = DDP_NUM_CHANNELS;
    e->flags            = effFlagsCanReplacing | effFlagsHasEditor;
    e->initialDelay     = DDP_LATENCY_SAMPLES;
    e->object           = st;
    e->uniqueID         = DDP_UNIQUE_ID;
    e->version          = DDP_VERSION;
    e->processReplacing = ddp_processReplacing;

    return e;
}

VST_EXPORT struct AEffect *main_entry(audioMasterCallback m) {
    return VSTPluginMain(m);
}

#ifdef __cplusplus
}
#endif

BOOL WINAPI DllMain(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p;
    return TRUE;
}
