/*
 * ddp_vst.c — DolbyX VST2 (Named Pipe mode)
 *
 * Connects to \\.\pipe\DolbyX served by dolbyx-bridge.exe.
 * This works from audiodg.exe (Windows audio service) which cannot
 * make TCP connections but CAN access named pipes.
 *
 * Build: x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"

#define DDP_UNIQUE_ID       0x44445031
#define DDP_VERSION         150
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512
#define CHUNK_SIZE          256
#define READY_MAGIC         0xDD901DAA
#define CMD_SHUTDOWN        0xFFFFFFFF
#define PIPE_NAME           "\\\\.\\pipe\\DolbyX"

typedef struct {
    HANDLE hPipe;
    int16_t pcm_in[CHUNK_SIZE * 2];
    int16_t pcm_out[CHUNK_SIZE * 2];
    int connected;
    int bypass;
    int block_count;
    float sample_rate;
    char dll_dir[512];
    FILE* logfp;
    audioMasterCallback master;
} DDPState;

/* ── Logging ─────────────────────────────────────────────────────── */

static void open_log(DDPState* st) {
    char path[600];
    snprintf(path, sizeof(path), "%s\\DolbyDDP.log", st->dll_dir);
    st->logfp = fopen(path, "a");
    if (!st->logfp)
        st->logfp = fopen("C:\\Users\\Public\\DolbyDDP.log", "a");
    if (!st->logfp) {
        char tmp[MAX_PATH]; GetTempPathA(sizeof(tmp), tmp);
        snprintf(path, sizeof(path), "%sDolbyDDP.log", tmp);
        st->logfp = fopen(path, "a");
    }
}

static void logf_(DDPState* st, const char* fmt, ...) {
    if (!st || !st->logfp) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(st->logfp, "[%02d:%02d:%02d.%03d PID:%lu] ",
            t.wHour, t.wMinute, t.wSecond, t.wMilliseconds,
            (unsigned long)GetCurrentProcessId());
    va_list a; va_start(a, fmt);
    vfprintf(st->logfp, fmt, a);
    va_end(a);
    fflush(st->logfp);
}

/* ── Pipe I/O ────────────────────────────────────────────────────── */

static BOOL pipe_read(HANDLE h, void* buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD r = 0;
        if (!ReadFile(h, (BYTE*)buf + total, n - total, &r, NULL) || r == 0)
            return FALSE;
        total += r;
    }
    return TRUE;
}

static BOOL pipe_write(HANDLE h, const void* buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD w = 0;
        if (!WriteFile(h, (const BYTE*)buf + total, n - total, &w, NULL) || w == 0)
            return FALSE;
        total += w;
    }
    return TRUE;
}

/* ── DLL Dir ─────────────────────────────────────────────────────── */

static void get_dll_dir(char* buf, size_t sz) {
    HMODULE hm = NULL;
    GetModuleHandleExA(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        (LPCSTR)&get_dll_dir, &hm);
    GetModuleFileNameA(hm, buf, (DWORD)sz);
    char* p = strrchr(buf, '\\');
    if (p) *p = '\0';
}

/* ── Connect to bridge via named pipe ────────────────────────────── */

static int connect_bridge(DDPState* st) {
    if (st->connected) return 0;

    logf_(st, "Opening named pipe %s...\n", PIPE_NAME);

    /* Try to open the named pipe (created by dolbyx-bridge.exe) */
    st->hPipe = CreateFileA(
        PIPE_NAME,
        GENERIC_READ | GENERIC_WRITE,
        0,              /* no sharing */
        NULL,           /* default security */
        OPEN_EXISTING,
        0,              /* default attributes */
        NULL
    );

    if (st->hPipe == INVALID_HANDLE_VALUE) {
        DWORD err = GetLastError();
        logf_(st, "CreateFile FAILED: err=%lu. Is dolbyx-bridge running?\n", err);
        return -1;
    }

    /* Set pipe to byte mode */
    DWORD mode = PIPE_READMODE_BYTE;
    SetNamedPipeHandleState(st->hPipe, &mode, NULL, NULL);

    logf_(st, "Pipe opened, reading magic...\n");

    /* Read ready magic from bridge */
    DWORD magic = 0;
    if (!pipe_read(st->hPipe, &magic, sizeof(magic)) || magic != READY_MAGIC) {
        logf_(st, "Bad magic: 0x%08X\n", magic);
        CloseHandle(st->hPipe);
        st->hPipe = INVALID_HANDLE_VALUE;
        return -1;
    }

    logf_(st, "Connected! DDP ready.\n");
    st->connected = 1;
    st->bypass = 0;
    st->block_count = 0;
    return 0;
}

static void disconnect_bridge(DDPState* st) {
    if (!st->connected) return;
    DWORD cmd = CMD_SHUTDOWN;
    pipe_write(st->hPipe, &cmd, sizeof(cmd));
    CloseHandle(st->hPipe);
    st->hPipe = INVALID_HANDLE_VALUE;
    st->connected = 0;
    logf_(st, "Disconnected after %d blocks\n", st->block_count);
}

/* ── processReplacing ────────────────────────────────────────────── */

static void ddp_processReplacing(struct AEffect* effect,
                                  float** inputs, float** outputs,
                                  int32_t sampleFrames) {
    DDPState* st = (DDPState*)effect->object;

    if (!st->connected && !st->bypass) {
        logf_(st, "Lazy connect (frames=%d)\n", sampleFrames);
        if (connect_bridge(st) != 0) {
            logf_(st, "Lazy connect failed → bypass\n");
            st->bypass = 1;
        }
    }

    if (!st->connected || st->bypass || sampleFrames <= 0) {
        if (inputs[0] != outputs[0])
            memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        if (inputs[1] != outputs[1])
            memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    int offset = 0;
    while (offset < sampleFrames) {
        int chunk = sampleFrames - offset;
        if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;

        for (int i = 0; i < chunk; i++) {
            float l = inputs[0][offset+i], r = inputs[1][offset+i];
            if (l > 1.0f) l = 1.0f; if (l < -1.0f) l = -1.0f;
            if (r > 1.0f) r = 1.0f; if (r < -1.0f) r = -1.0f;
            st->pcm_in[i*2]   = (int16_t)(l * 32767.0f);
            st->pcm_in[i*2+1] = (int16_t)(r * 32767.0f);
        }

        DWORD fc = (DWORD)chunk;
        DWORD pcm_bytes = chunk * 2 * sizeof(int16_t);

        if (!pipe_write(st->hPipe, &fc, sizeof(fc)) ||
            !pipe_write(st->hPipe, st->pcm_in, pcm_bytes)) {
            logf_(st, "Write FAILED at block %d\n", st->block_count);
            st->connected = 0; st->bypass = 1;
            for (int i = offset; i < sampleFrames; i++) {
                outputs[0][i] = inputs[0][i]; outputs[1][i] = inputs[1][i];
            }
            return;
        }

        if (!pipe_read(st->hPipe, st->pcm_out, pcm_bytes)) {
            logf_(st, "Read FAILED at block %d\n", st->block_count);
            st->connected = 0; st->bypass = 1;
            for (int i = offset; i < sampleFrames; i++) {
                outputs[0][i] = inputs[0][i]; outputs[1][i] = inputs[1][i];
            }
            return;
        }

        const float scale = 1.0f / 32767.0f;
        for (int i = 0; i < chunk; i++) {
            outputs[0][offset+i] = (float)st->pcm_out[i*2]   * scale;
            outputs[1][offset+i] = (float)st->pcm_out[i*2+1] * scale;
        }
        offset += chunk;
    }

    st->block_count++;
    if (st->block_count <= 5 || st->block_count % 5000 == 0)
        logf_(st, "Block %d: frames=%d\n", st->block_count, sampleFrames);
}

/* ── Parameter ───────────────────────────────────────────────────── */

static float ddp_getParam(struct AEffect* e, int32_t i) {
    DDPState* st = (DDPState*)e->object;
    return (i == 0 && st) ? (st->bypass ? 1.0f : 0.0f) : 0.0f;
}
static void ddp_setParam(struct AEffect* e, int32_t i, float v) {
    DDPState* st = (DDPState*)e->object;
    if (i == 0 && st) {
        if (v > 0.5f && !st->bypass) disconnect_bridge(st);
        st->bypass = (v > 0.5f) ? 1 : 0;
    }
}

/* ── Dispatcher ──────────────────────────────────────────────────── */

static intptr_t ddp_dispatch(struct AEffect* effect,
    int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt) {
    DDPState* st = (DDPState*)effect->object;
    switch (opcode) {
    case effOpen: {
        get_dll_dir(st->dll_dir, sizeof(st->dll_dir));
        open_log(st);
        char exe[MAX_PATH] = {0};
        GetModuleFileNameA(NULL, exe, sizeof(exe));
        logf_(st, "\n===== DolbyX VST opened (pipe mode) =====\n");
        logf_(st, "Host: %s\n", exe);
        if (connect_bridge(st) != 0)
            logf_(st, "effOpen: bridge not running, will retry\n");
        return 0;
    }
    case effClose:
        logf_(st, "effClose: blocks=%d\n", st->block_count);
        disconnect_bridge(st);
        if (st->logfp) fclose(st->logfp);
        free(st); effect->object = NULL;
        return 0;
    case effSetSampleRate:
        if (st) { st->sample_rate = opt; logf_(st, "Rate: %.0f\n", opt); }
        return 0;
    case effSetBlockSize:
        if (st) logf_(st, "BlockSize: %d\n", (int)value);
        return 0;
    case effMainsChanged:
        if (st) {
            logf_(st, "MainsChanged: %d\n", (int)value);
            if (value && !st->connected && !st->bypass)
                connect_bridge(st);
        }
        return 0;
    case effGetEffectName:    strcpy((char*)ptr, "DolbyX DDP"); return 1;
    case effGetVendorString:  strcpy((char*)ptr, "DolbyX"); return 1;
    case effGetProductString: strcpy((char*)ptr, "Dolby Digital Plus Bridge"); return 1;
    case effGetVendorVersion: return DDP_VERSION;
    case effGetVstVersion:    return kVstVersion;
    case effGetPlugCategory:  return kPlugCategEffect;
    case effCanDo:
        if (ptr && !strcmp((char*)ptr, "receiveVstEvents")) return -1;
        if (ptr && !strcmp((char*)ptr, "receiveVstMidiEvent")) return -1;
        return 0;
    case effGetParamName: case effGetParamLabel: case effGetParamDisplay:
        if (index == 0 && ptr) {
            strcpy((char*)ptr, opcode == effGetParamDisplay
                ? (st->bypass ? "ON" : "OFF") : "Bypass");
            return 1;
        }
        return 0;
    default: return 0;
    }
}

/* ── Entry ───────────────────────────────────────────────────────── */

#ifdef __cplusplus
extern "C" {
#endif

VST_EXPORT struct AEffect* VSTPluginMain(audioMasterCallback audioMaster) {
    if (!audioMaster) return NULL;
    if (!audioMaster(NULL, audioMasterVersion, 0, 0, NULL, 0.0f)) return NULL;
    DDPState* st = (DDPState*)calloc(1, sizeof(DDPState));
    if (!st) return NULL;
    st->master = audioMaster; st->sample_rate = 48000.0f;
    st->hPipe = INVALID_HANDLE_VALUE;
    struct AEffect* e = (struct AEffect*)calloc(1, sizeof(struct AEffect));
    if (!e) { free(st); return NULL; }
    e->magic = 0x56737450;
    e->dispatcher = ddp_dispatch;
    e->setParameter = ddp_setParam;
    e->getParameter = ddp_getParam;
    e->numPrograms = 1; e->numParams = 1;
    e->numInputs = DDP_NUM_CHANNELS; e->numOutputs = DDP_NUM_CHANNELS;
    e->flags = effFlagsCanReplacing;
    e->initialDelay = DDP_LATENCY_SAMPLES;
    e->object = st;
    e->uniqueID = DDP_UNIQUE_ID;
    e->version = DDP_VERSION;
    e->processReplacing = ddp_processReplacing;
    return e;
}
VST_EXPORT struct AEffect* main_entry(audioMasterCallback m) { return VSTPluginMain(m); }

#ifdef __cplusplus
}
#endif

BOOL WINAPI DllMain(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p; return TRUE;
}
