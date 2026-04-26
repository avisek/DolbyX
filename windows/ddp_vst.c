/*
 * ddp_vst.c — DolbyX VST2 Plugin (Named Pipe, Batch Protocol)
 *
 * Connects to \\.\pipe\DolbyX served by dolbyx-bridge.exe.
 * Sends entire audio blocks in single pipe writes for efficiency.
 * Auto-reconnects when the bridge restarts.
 *
 * Build:
 *   x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"

/* ── Configuration ────────────────────────────────────────────────── */

#define DDP_UNIQUE_ID       0x44445031  /* 'DDP1' */
#define DDP_VERSION         170
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512         /* ~10.7ms at 48kHz */
#define MAX_FRAMES          131072
#define READY_MAGIC         0xDD901DAA
#define CMD_SHUTDOWN        0xFFFFFFFF
#define PIPE_NAME           "\\\\.\\pipe\\DolbyX"

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
    char path[600];

    /* Try: next to DLL, then Public, then Temp */
    snprintf(path, sizeof(path), "%s\\DolbyDDP.log", st->dll_dir);
    st->logfp = fopen(path, "a");

    if (!st->logfp)
        st->logfp = fopen("C:\\Users\\Public\\DolbyDDP.log", "a");

    if (!st->logfp) {
        char tmp[MAX_PATH];
        GetTempPathA(sizeof(tmp), tmp);
        snprintf(path, sizeof(path), "%sDolbyDDP.log", tmp);
        st->logfp = fopen(path, "a");
    }
}

static void logf_(DDPState *st, const char *fmt, ...) {
    if (!st || !st->logfp) return;
    SYSTEMTIME t;
    GetLocalTime(&t);
    fprintf(st->logfp, "[%02d:%02d:%02d.%03d PID:%lu] ",
            t.wHour, t.wMinute, t.wSecond, t.wMilliseconds,
            (unsigned long)GetCurrentProcessId());
    va_list a;
    va_start(a, fmt);
    vfprintf(st->logfp, fmt, a);
    va_end(a);
    fflush(st->logfp);
}

/* ── Pipe I/O ─────────────────────────────────────────────────────── */

static BOOL p_read(HANDLE h, void *buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD r = 0;
        if (!ReadFile(h, (BYTE *)buf + total, n - total, &r, NULL) || r == 0)
            return FALSE;
        total += r;
    }
    return TRUE;
}

static BOOL p_write(HANDLE h, const void *buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD w = 0;
        if (!WriteFile(h, (const BYTE *)buf + total, n - total, &w, NULL) || w == 0)
            return FALSE;
        total += w;
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

    /* Retry loop: if pipe is busy (another client just connected and the
     * bridge hasn't created the next instance yet), wait and retry. */
    for (int attempt = 0; attempt < 5; attempt++) {
        st->pipe = CreateFileA(PIPE_NAME, GENERIC_READ | GENERIC_WRITE,
                               0, NULL, OPEN_EXISTING, 0, NULL);

        if (st->pipe != INVALID_HANDLE_VALUE)
            break; /* success */

        DWORD err = GetLastError();
        if (err == ERROR_PIPE_BUSY) {
            /* Wait up to 2 seconds for the pipe to become available */
            if (WaitNamedPipeA(PIPE_NAME, 2000))
                continue; /* retry CreateFile */
        }

        logf_(st, "Pipe open failed: err=%lu (attempt %d)\n", err, attempt + 1);
        return -1;
    }

    if (st->pipe == INVALID_HANDLE_VALUE) {
        logf_(st, "Pipe open failed after retries\n");
        return -1;
    }

    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(st->pipe, &mode, NULL, NULL);

    DWORD magic = 0;
    if (!p_read(st->pipe, &magic, 4) || magic != READY_MAGIC) {
        logf_(st, "Bad magic: 0x%08X\n", magic);
        CloseHandle(st->pipe);
        st->pipe = INVALID_HANDLE_VALUE;
        return -1;
    }

    logf_(st, "Connected to bridge\n");
    st->connected = 1;
    st->bypass = 0;
    st->block_count = 0;
    return 0;
}

static void disconnect_bridge(DDPState *st) {
    if (!st->connected) return;
    DWORD cmd = CMD_SHUTDOWN;
    p_write(st->pipe, &cmd, 4);
    CloseHandle(st->pipe);
    st->pipe = INVALID_HANDLE_VALUE;
    st->connected = 0;
    logf_(st, "Disconnected after %d blocks\n", st->block_count);
}

/* ── Audio Processing (Batch Mode) ────────────────────────────────── */

static void ddp_processReplacing(struct AEffect *effect,
                                  float **inputs, float **outputs,
                                  int32_t sampleFrames) {
    DDPState *st = (DDPState *)effect->object;

    /* Lazy connect / auto-reconnect */
    if (!st->connected && !st->bypass) {
        if (connect_bridge(st) != 0) {
            st->bypass = 1;
            logf_(st, "Bridge unavailable, bypass mode\n");
        }
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

    /* Float -> int16 interleaved */
    for (int i = 0; i < frames; i++) {
        float l = inputs[0][i], r = inputs[1][i];
        if (l >  1.0f) l =  1.0f;
        if (l < -1.0f) l = -1.0f;
        if (r >  1.0f) r =  1.0f;
        if (r < -1.0f) r = -1.0f;
        st->pcm_buf[i * 2]     = (int16_t)(l * 32767.0f);
        st->pcm_buf[i * 2 + 1] = (int16_t)(r * 32767.0f);
    }

    /* Single write: frame_count + PCM */
    DWORD fc = (DWORD)frames;
    if (!p_write(st->pipe, &fc, 4) ||
        !p_write(st->pipe, st->pcm_buf, pcm_bytes)) {
        logf_(st, "Write failed at block %d\n", st->block_count);
        st->connected = 0;
        st->bypass = 1;
        memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    /* Single read: processed PCM */
    if (!p_read(st->pipe, st->pcm_buf, pcm_bytes)) {
        logf_(st, "Read failed at block %d\n", st->block_count);
        st->connected = 0;
        st->bypass = 1;
        memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    /* Int16 -> float */
    const float scale = 1.0f / 32767.0f;
    for (int i = 0; i < frames; i++) {
        outputs[0][i] = (float)st->pcm_buf[i * 2]     * scale;
        outputs[1][i] = (float)st->pcm_buf[i * 2 + 1] * scale;
    }
    for (int i = frames; i < sampleFrames; i++) {
        outputs[0][i] = 0.0f;
        outputs[1][i] = 0.0f;
    }

    st->block_count++;
    if (st->block_count <= 3 || st->block_count % 5000 == 0)
        logf_(st, "Block %d: %d frames\n", st->block_count, frames);
}

/* ── VST Parameter ────────────────────────────────────────────────── */

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

/* ── VST Dispatcher ───────────────────────────────────────────────── */

static intptr_t ddp_dispatch(struct AEffect *effect,
    int32_t opcode, int32_t index, intptr_t value, void *ptr, float opt) {

    DDPState *st = (DDPState *)effect->object;

    switch (opcode) {
    case effOpen: {
        get_dll_dir(st->dll_dir, sizeof(st->dll_dir));
        open_log(st);

        char exe[MAX_PATH] = {0};
        GetModuleFileNameA(NULL, exe, sizeof(exe));
        logf_(st, "\n===== DolbyX VST opened =====\n");
        logf_(st, "Host: %s\n", exe);

        st->pcm_buf = (int16_t *)malloc(MAX_FRAMES * 2 * sizeof(int16_t));
        if (connect_bridge(st) != 0)
            logf_(st, "Bridge not running, will retry on first audio block\n");
        return 0;
    }

    case effClose:
        logf_(st, "effClose: %d blocks processed\n", st->block_count);
        disconnect_bridge(st);
        if (st->logfp) fclose(st->logfp);
        free(st->pcm_buf);
        free(st);
        effect->object = NULL;
        return 0;

    case effSetSampleRate:
        if (st) { st->sample_rate = opt; logf_(st, "SampleRate: %.0f\n", opt); }
        return 0;

    case effSetBlockSize:
        if (st) logf_(st, "BlockSize: %d\n", (int)value);
        return 0;

    case effMainsChanged:
        if (st) {
            logf_(st, "MainsChanged: %d\n", (int)value);
            if (value == 1 && !st->connected && !st->bypass) {
                /* Resume: try reconnecting to bridge */
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

    case effGetParamName:
    case effGetParamLabel:
    case effGetParamDisplay:
        if (index == 0 && ptr) {
            strcpy((char *)ptr,
                   opcode == effGetParamDisplay
                       ? (st->bypass ? "ON" : "OFF")
                       : "Bypass");
            return 1;
        }
        return 0;

    default:
        return 0;
    }
}

/* ── VST Entry Point ──────────────────────────────────────────────── */

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

    e->magic            = 0x56737450;  /* 'VstP' */
    e->dispatcher       = ddp_dispatch;
    e->setParameter     = ddp_setParam;
    e->getParameter     = ddp_getParam;
    e->numPrograms      = 1;
    e->numParams        = 1;
    e->numInputs        = DDP_NUM_CHANNELS;
    e->numOutputs       = DDP_NUM_CHANNELS;
    e->flags            = effFlagsCanReplacing;
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
