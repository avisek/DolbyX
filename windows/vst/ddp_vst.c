/*
 * ddp_vst.c — DolbyX VST2 Plugin
 *
 * Audio processing via named pipe to the DolbyX daemon.
 * No built-in editor — opens Web UI in system browser.
 * Daemon owns all state/persistence — VST is stateless.
 *
 * Build:
 *   x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll \
 *     ddp_vst.c -static -lshell32
 */

#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"
#include "ddp_protocol.h"

#define DDP_UNIQUE_ID       0x44445031
#define DDP_VERSION         200
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512
#define MAX_FRAMES          131072
#define PIPE_NAME           "\\\\.\\pipe\\DolbyX"
#define WEBUI_URL           L"http://localhost:9876"

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
} DDPState;

/* ── Logging ──────────────────────────────────────────────────────── */

static void open_log(DDPState *st) {
    char p[600];
    snprintf(p, sizeof(p), "%s\\DolbyDDP.log", st->dll_dir);
    st->logfp = fopen(p, "a");
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
    while (t < n) { DWORD r = 0;
        if (!ReadFile(h, (BYTE*)buf+t, n-t, &r, NULL) || !r) return FALSE;
        t += r; }
    return TRUE;
}

static BOOL p_write(HANDLE h, const void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) { DWORD w = 0;
        if (!WriteFile(h, (const BYTE*)buf+t, n-t, &w, NULL) || !w) return FALSE;
        t += w; }
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

/* ── Connection ───────────────────────────────────────────────────── */

static int connect_pipe(DDPState *st) {
    if (st->connected) return 0;
    for (int attempt = 0; attempt < 5; attempt++) {
        st->pipe = CreateFileA(PIPE_NAME, GENERIC_READ | GENERIC_WRITE,
                               0, NULL, OPEN_EXISTING, 0, NULL);
        if (st->pipe != INVALID_HANDLE_VALUE) break;
        if (GetLastError() == ERROR_PIPE_BUSY)
            WaitNamedPipeA(PIPE_NAME, 2000);
        else return -1;
    }
    if (st->pipe == INVALID_HANDLE_VALUE) return -1;
    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(st->pipe, &mode, NULL, NULL);
    DWORD magic = 0;
    if (!p_read(st->pipe, &magic, 4) || magic != DDP_READY_MAGIC) {
        CloseHandle(st->pipe); st->pipe = INVALID_HANDLE_VALUE; return -1;
    }
    logf_(st, "Connected to daemon\n");
    st->connected = 1; st->bypass = 0; st->block_count = 0;
    return 0;
}

static void disconnect_pipe(DDPState *st) {
    if (!st->connected) return;
    DWORD cmd = DDP_CMD_SHUTDOWN;
    p_write(st->pipe, &cmd, 4);
    CloseHandle(st->pipe); st->pipe = INVALID_HANDLE_VALUE;
    st->connected = 0;
    logf_(st, "Disconnected after %d blocks\n", st->block_count);
}

/* ── processReplacing ────────────────────────────────────────────── */

static void ddp_process(struct AEffect *effect,
                        float **inputs, float **outputs,
                        int32_t sampleFrames) {
    DDPState *st = (DDPState *)effect->object;

    if (!st->connected && !st->bypass) {
        if (connect_pipe(st) != 0) st->bypass = 1;
    }

    if (!st->connected || st->bypass || sampleFrames <= 0) {
        if (inputs[0] != outputs[0])
            memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        if (inputs[1] != outputs[1])
            memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    int frames = (sampleFrames > MAX_FRAMES) ? MAX_FRAMES : sampleFrames;
    DWORD pcm_bytes = frames * 2 * sizeof(int16_t);

    for (int i = 0; i < frames; i++) {
        float l = inputs[0][i], r = inputs[1][i];
        if (l >  1.0f) l =  1.0f; if (l < -1.0f) l = -1.0f;
        if (r >  1.0f) r =  1.0f; if (r < -1.0f) r = -1.0f;
        st->pcm_buf[i*2]   = (int16_t)(l * 32767.0f);
        st->pcm_buf[i*2+1] = (int16_t)(r * 32767.0f);
    }

    DWORD fc = (DWORD)frames;
    if (!p_write(st->pipe, &fc, 4) || !p_write(st->pipe, st->pcm_buf, pcm_bytes) ||
        !p_read(st->pipe, st->pcm_buf, pcm_bytes)) {
        st->connected = 0; st->bypass = 1;
        memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    const float scale = 1.0f / 32767.0f;
    for (int i = 0; i < frames; i++) {
        outputs[0][i] = st->pcm_buf[i*2]   * scale;
        outputs[1][i] = st->pcm_buf[i*2+1] * scale;
    }
    for (int i = frames; i < sampleFrames; i++) {
        outputs[0][i] = 0.0f; outputs[1][i] = 0.0f;
    }

    st->block_count++;
    if (st->block_count <= 3 || st->block_count % 5000 == 0)
        logf_(st, "Block %d: %d frames\n", st->block_count, frames);
}

/* ── Dispatcher ───────────────────────────────────────────────────── */

static float ddp_getParam(struct AEffect *e, int32_t i) { (void)e;(void)i; return 0; }
static void ddp_setParam(struct AEffect *e, int32_t i, float v) { (void)e;(void)i;(void)v; }

static intptr_t ddp_dispatch(struct AEffect *effect,
    int32_t opcode, int32_t index, intptr_t value, void *ptr, float opt) {

    DDPState *st = (DDPState *)effect->object;

    switch (opcode) {
    case effOpen: {
        get_dll_dir(st->dll_dir, sizeof(st->dll_dir));
        open_log(st);
        char exe[MAX_PATH] = {0};
        GetModuleFileNameA(NULL, exe, sizeof(exe));
        logf_(st, "\n===== DolbyX v2.0 =====\n");
        logf_(st, "Host: %s\n", exe);
        st->pcm_buf = (int16_t *)malloc(MAX_FRAMES * 2 * sizeof(int16_t));
        /* State is managed by daemon — VST just connects and processes audio */
        if (connect_pipe(st) != 0)
            logf_(st, "Daemon not running\n");
        return 0;
    }

    case effClose:
        logf_(st, "effClose: %d blocks\n", st->block_count);
        disconnect_pipe(st);
        if (st->logfp) fclose(st->logfp);
        free(st->pcm_buf);
        free(st);
        effect->object = NULL;
        return 0;

    /* Editor — open Web UI in browser */
    case effEditGetRect: {
        static ERect r = {0, 0, 0, 0};
        *(ERect **)ptr = &r;
        return 1;
    }
    case effEditOpen: {
        ShellExecuteW(NULL, L"open", WEBUI_URL, NULL, NULL, SW_SHOWNORMAL);
        /* Dismiss the VST popup window (but not the main APO editor) */
        HWND root = GetAncestor((HWND)ptr, GA_ROOT);
        char title[256] = {0};
        GetWindowTextA(root, title, sizeof(title));
        if (strstr(title, "DolbyX") != NULL)
            PostMessage(root, WM_CLOSE, 0, 0);
        return 1;
    }
    case effEditClose: return 0;
    case effEditIdle:  return 0;

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
                connect_pipe(st);
            }
        }
        return 0;

    case effGetEffectName:    strcpy((char *)ptr, "DolbyX");  return 1;
    case effGetVendorString:  strcpy((char *)ptr, "DolbyX");  return 1;
    case effGetProductString: strcpy((char *)ptr, "DolbyX");  return 1;
    case effGetVendorVersion: return DDP_VERSION;
    case effGetVstVersion:    return kVstVersion;
    case effGetPlugCategory:  return kPlugCategEffect;

    case effCanDo:
        if (ptr && !strcmp((char *)ptr, "receiveVstEvents"))    return -1;
        if (ptr && !strcmp((char *)ptr, "receiveVstMidiEvent")) return -1;
        return 0;

    default: return 0;
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
    e->numParams        = 0;
    e->numInputs        = DDP_NUM_CHANNELS;
    e->numOutputs       = DDP_NUM_CHANNELS;
    e->flags            = effFlagsCanReplacing | effFlagsHasEditor;
    e->initialDelay     = DDP_LATENCY_SAMPLES;
    e->object           = st;
    e->uniqueID         = DDP_UNIQUE_ID;
    e->version          = DDP_VERSION;
    e->processReplacing = ddp_process;

    return e;
}

VST_EXPORT struct AEffect *main_entry(audioMasterCallback m) {
    return VSTPluginMain(m);
}

#ifdef __cplusplus
}
#endif

BOOL WINAPI DllMain(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p; return TRUE;
}
