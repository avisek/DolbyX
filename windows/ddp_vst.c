/*
 * ddp_vst.c — DolbyX VST2 Bridge for Windows
 *
 * Pipes audio to the DDP ARM processor running in WSL2 via QEMU.
 * For use with EqualizerAPO or any VST2 host.
 *
 * Build (MinGW from WSL2):
 *   x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -static
 *
 * Debug: writes to DolbyDDP.log next to the DLL.
 */

#ifdef _MSC_VER
#define _CRT_SECURE_NO_WARNINGS
#endif

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"

#define DDP_UNIQUE_ID       0x44445031
#define DDP_VERSION         120
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512
#define CHUNK_SIZE          256    /* DDP internal processing block size */
#define READY_MAGIC         0xDD901DAA
#define CMD_SHUTDOWN        0xFFFFFFFF

typedef struct {
    HANDLE hProcess;
    HANDLE hStdinWrite;
    HANDLE hStdoutRead;
    int16_t* pcm_in;
    int16_t* pcm_out;
    int is_running;
    int bypass;
    int block_count;
    float sample_rate;
    char wsl_distro[64];
    char ddp_path[512];
    char dll_dir[512];
    FILE* logfp;
    audioMasterCallback master;
} DDPState;

/* ── Logging ─────────────────────────────────────────────────────────── */

static void logf_(DDPState* st, const char* fmt, ...) {
    if (!st || !st->logfp) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(st->logfp, "[%02d:%02d:%02d.%03d] ",
            t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a; va_start(a, fmt);
    vfprintf(st->logfp, fmt, a);
    va_end(a);
    fflush(st->logfp);
}

/* ── Pipe I/O ────────────────────────────────────────────────────────── */

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

/* ── DLL Directory ───────────────────────────────────────────────────── */

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

/* ── Config ──────────────────────────────────────────────────────────── */

static void load_config(DDPState* st) {
    strcpy(st->wsl_distro, "Ubuntu");
    strcpy(st->ddp_path, "/home/user/DolbyX/arm");

    const char* ep = getenv("DDP_WSL_PATH");
    if (ep && *ep) strncpy(st->ddp_path, ep, sizeof(st->ddp_path) - 1);
    const char* ed = getenv("DDP_WSL_DISTRO");
    if (ed && *ed) strncpy(st->wsl_distro, ed, sizeof(st->wsl_distro) - 1);

    char ini[600];
    snprintf(ini, sizeof(ini), "%s\\ddp_config.ini", st->dll_dir);
    GetPrivateProfileStringA("DDP", "wsl_distro", st->wsl_distro,
                             st->wsl_distro, sizeof(st->wsl_distro), ini);
    GetPrivateProfileStringA("DDP", "ddp_path", st->ddp_path,
                             st->ddp_path, sizeof(st->ddp_path), ini);

    logf_(st, "Config: distro=%s path=%s\n", st->wsl_distro, st->ddp_path);
}

/* ── WSL2 Process ────────────────────────────────────────────────────── */

static int start_wsl(DDPState* st) {
    if (st->is_running) return 0;

    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE hChildStdinRead, hChildStdoutWrite;

    if (!CreatePipe(&hChildStdinRead, &st->hStdinWrite, &sa, 1024 * 1024) ||
        !CreatePipe(&st->hStdoutRead, &hChildStdoutWrite, &sa, 1024 * 1024)) {
        logf_(st, "CreatePipe failed: %lu\n", GetLastError());
        return -1;
    }
    SetHandleInformation(st->hStdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(st->hStdoutRead, HANDLE_FLAG_INHERIT, 0);

    /* Full path to wsl.exe — audiodg.exe (EqualizerAPO host) may not
       have it in PATH since it runs under a different user context. */
    char cmdline[2048];
    snprintf(cmdline, sizeof(cmdline),
        "C:\\Windows\\System32\\wsl.exe -d %s -- bash -c \""
        "cd '%s' && "
        "LD_LIBRARY_PATH=build/lib "
        "qemu-arm-static -L /usr/arm-linux-gnueabihf "
        "build/ddp_processor build/lib/libdseffect.so 48000 -6 0"
        "\"",
        st->wsl_distro, st->ddp_path);

    logf_(st, "Launching: %s\n", cmdline);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput  = hChildStdinRead;
    si.hStdOutput = hChildStdoutWrite;
    si.hStdError  = INVALID_HANDLE_VALUE;
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmdline, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        logf_(st, "CreateProcess FAILED: error=%lu\n", GetLastError());
        CloseHandle(hChildStdinRead);
        CloseHandle(hChildStdoutWrite);
        CloseHandle(st->hStdinWrite);
        CloseHandle(st->hStdoutRead);
        return -1;
    }

    CloseHandle(hChildStdinRead);
    CloseHandle(hChildStdoutWrite);
    st->hProcess = pi.hProcess;
    CloseHandle(pi.hThread);

    logf_(st, "Process started, waiting for magic...\n");

    uint32_t magic = 0;
    if (!pipe_read(st->hStdoutRead, &magic, sizeof(magic))) {
        logf_(st, "Failed to read magic\n");
        TerminateProcess(st->hProcess, 1);
        CloseHandle(st->hProcess);
        CloseHandle(st->hStdinWrite);
        CloseHandle(st->hStdoutRead);
        return -1;
    }
    if (magic != READY_MAGIC) {
        logf_(st, "Bad magic: 0x%08X\n", magic);
        TerminateProcess(st->hProcess, 1);
        CloseHandle(st->hProcess);
        CloseHandle(st->hStdinWrite);
        CloseHandle(st->hStdoutRead);
        return -1;
    }

    logf_(st, "DDP processor ready!\n");
    st->is_running = 1;
    st->bypass = 0;
    st->block_count = 0;
    return 0;
}

static void stop_wsl(DDPState* st) {
    if (!st->is_running) return;
    uint32_t cmd = CMD_SHUTDOWN;
    pipe_write(st->hStdinWrite, &cmd, sizeof(cmd));
    if (WaitForSingleObject(st->hProcess, 2000) == WAIT_TIMEOUT)
        TerminateProcess(st->hProcess, 1);
    CloseHandle(st->hStdinWrite);
    CloseHandle(st->hStdoutRead);
    CloseHandle(st->hProcess);
    st->is_running = 0;
    logf_(st, "Process stopped after %d blocks\n", st->block_count);
}

/* ── processReplacing ────────────────────────────────────────────────── */

/* DDP processes in fixed 256-frame chunks internally.
 * EqualizerAPO may send up to 65536 frames per call.
 * We loop through in CHUNK_SIZE pieces. */

static void ddp_processReplacing(struct AEffect* effect,
                                  float** inputs, float** outputs,
                                  int32_t sampleFrames) {
    DDPState* st = (DDPState*)effect->object;

    /* Lazy init */
    if (!st->is_running && !st->bypass) {
        logf_(st, "Lazy init from processReplacing (frames=%d)\n", sampleFrames);
        if (start_wsl(st) != 0) {
            logf_(st, "Lazy init failed\n");
            st->bypass = 1;
        }
    }

    if (!st->is_running || st->bypass || sampleFrames <= 0) {
        if (inputs[0] != outputs[0])
            memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        if (inputs[1] != outputs[1])
            memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    /* Process entire buffer in CHUNK_SIZE-frame pieces */
    int offset = 0;
    while (offset < sampleFrames) {
        int chunk = sampleFrames - offset;
        if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;

        /* Float → int16 interleaved */
        for (int i = 0; i < chunk; i++) {
            float l = inputs[0][offset + i];
            float r = inputs[1][offset + i];
            if (l >  1.0f) l =  1.0f; if (l < -1.0f) l = -1.0f;
            if (r >  1.0f) r =  1.0f; if (r < -1.0f) r = -1.0f;
            st->pcm_in[i*2]   = (int16_t)(l * 32767.0f);
            st->pcm_in[i*2+1] = (int16_t)(r * 32767.0f);
        }

        uint32_t fc = (uint32_t)chunk;
        DWORD pcm_bytes = chunk * 2 * sizeof(int16_t);

        if (!pipe_write(st->hStdinWrite, &fc, sizeof(fc)) ||
            !pipe_write(st->hStdinWrite, st->pcm_in, pcm_bytes)) {
            logf_(st, "Pipe write FAILED at block %d offset %d\n",
                  st->block_count, offset);
            st->bypass = 1;
            /* Fill remaining output with input (passthrough) */
            for (int i = offset; i < sampleFrames; i++) {
                outputs[0][i] = inputs[0][i];
                outputs[1][i] = inputs[1][i];
            }
            return;
        }

        if (!pipe_read(st->hStdoutRead, st->pcm_out, pcm_bytes)) {
            logf_(st, "Pipe read FAILED at block %d offset %d\n",
                  st->block_count, offset);
            st->bypass = 1;
            for (int i = offset; i < sampleFrames; i++) {
                outputs[0][i] = inputs[0][i];
                outputs[1][i] = inputs[1][i];
            }
            return;
        }

        /* Int16 → float */
        const float scale = 1.0f / 32767.0f;
        for (int i = 0; i < chunk; i++) {
            outputs[0][offset + i] = (float)st->pcm_out[i*2]   * scale;
            outputs[1][offset + i] = (float)st->pcm_out[i*2+1] * scale;
        }

        offset += chunk;
    }

    st->block_count++;
    if (st->block_count <= 5 || st->block_count % 10000 == 0)
        logf_(st, "Block %d OK: frames=%d chunks=%d\n",
              st->block_count, sampleFrames, (sampleFrames + CHUNK_SIZE - 1) / CHUNK_SIZE);
}

/* ── getParameter / setParameter ─────────────────────────────────────── */

static float ddp_getParameter(struct AEffect* e, int32_t i) {
    DDPState* st = (DDPState*)e->object;
    return (i == 0 && st) ? (st->bypass ? 1.0f : 0.0f) : 0.0f;
}
static void ddp_setParameter(struct AEffect* e, int32_t i, float v) {
    DDPState* st = (DDPState*)e->object;
    if (i == 0 && st) st->bypass = (v > 0.5f) ? 1 : 0;
}

/* ── dispatcher ──────────────────────────────────────────────────────── */

static intptr_t ddp_dispatcher(struct AEffect* effect,
    int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt) {
    DDPState* st = (DDPState*)effect->object;
    switch (opcode) {
    case effOpen:
        get_dll_dir(st->dll_dir, sizeof(st->dll_dir));
        { char lp[600]; snprintf(lp, sizeof(lp), "%s\\DolbyDDP.log", st->dll_dir);
          st->logfp = fopen(lp, "a"); }
        logf_(st, "\n===== DolbyX VST opened =====\n");
        load_config(st);
        st->pcm_in  = (int16_t*)calloc(CHUNK_SIZE * 2, sizeof(int16_t));
        st->pcm_out = (int16_t*)calloc(CHUNK_SIZE * 2, sizeof(int16_t));
        if (start_wsl(st) != 0)
            logf_(st, "effOpen: start_wsl failed, will retry lazily\n");
        return 0;

    case effClose:
        logf_(st, "effClose: blocks=%d\n", st ? st->block_count : -1);
        stop_wsl(st);
        if (st->logfp) fclose(st->logfp);
        free(st->pcm_in); free(st->pcm_out); free(st);
        effect->object = NULL;
        return 0;

    case effSetSampleRate:
        if (st) { st->sample_rate = opt; logf_(st, "SampleRate: %.0f\n", opt); }
        return 0;
    case effSetBlockSize:
        if (st) logf_(st, "BlockSize: %d\n", (int)value);
        return 0;
    case effMainsChanged:
        if (st) logf_(st, "MainsChanged: %d\n", (int)value);
        return 0;
    case effGetEffectName:
        strcpy((char*)ptr, "DolbyX DDP"); return 1;
    case effGetVendorString:
        strcpy((char*)ptr, "DolbyX"); return 1;
    case effGetProductString:
        strcpy((char*)ptr, "Dolby Digital Plus Bridge"); return 1;
    case effGetVendorVersion:
        return DDP_VERSION;
    case effGetVstVersion:
        return kVstVersion;
    case effGetPlugCategory:
        return kPlugCategEffect;
    case effCanDo:
        if (ptr) {
            if (st) logf_(st, "CanDo: %s\n", (char*)ptr);
            if (!strcmp((char*)ptr, "receiveVstEvents")) return -1;
            if (!strcmp((char*)ptr, "receiveVstMidiEvent")) return -1;
        }
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

/* ── Entry ───────────────────────────────────────────────────────────── */

#ifdef __cplusplus
extern "C" {
#endif

VST_EXPORT struct AEffect* VSTPluginMain(audioMasterCallback audioMaster) {
    if (!audioMaster) return NULL;
    if (!audioMaster(NULL, audioMasterVersion, 0, 0, NULL, 0.0f)) return NULL;
    DDPState* st = (DDPState*)calloc(1, sizeof(DDPState));
    if (!st) return NULL;
    st->master = audioMaster;
    st->sample_rate = 48000.0f;
    struct AEffect* e = (struct AEffect*)calloc(1, sizeof(struct AEffect));
    if (!e) { free(st); return NULL; }
    e->magic = 0x56737450;
    e->dispatcher = ddp_dispatcher;
    e->setParameter = ddp_setParameter;
    e->getParameter = ddp_getParameter;
    e->numPrograms = 1;
    e->numParams = 1;
    e->numInputs = DDP_NUM_CHANNELS;
    e->numOutputs = DDP_NUM_CHANNELS;
    e->flags = effFlagsCanReplacing;
    e->initialDelay = DDP_LATENCY_SAMPLES;
    e->object = st;
    e->uniqueID = DDP_UNIQUE_ID;
    e->version = DDP_VERSION;
    e->processReplacing = ddp_processReplacing;
    return e;
}

VST_EXPORT struct AEffect* main_entry(audioMasterCallback m) {
    return VSTPluginMain(m);
}

#ifdef __cplusplus
}
#endif

BOOL WINAPI DllMain(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p; return TRUE;
}
