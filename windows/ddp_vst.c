/*
 * ddp_vst.c — Dolby Digital Plus VST2 Bridge for Windows
 *
 * This VST2 plugin spawns the ARM DDP processor under WSL2/QEMU and
 * pipes audio to/from it. For use with EqualizerAPO or any VST2 host.
 *
 * Build (MinGW-w64, from WSL2 or MSYS2):
 *   x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -lole32 -static
 *
 * Build (MSVC Developer Command Prompt):
 *   cl /LD /O2 ddp_vst.c /Fe:DolbyDDP.dll
 *
 * Configuration:
 *   Place ddp_config.ini next to the DLL:
 *     [DDP]
 *     wsl_distro=Ubuntu
 *     ddp_path=/home/youruser/ddp-portable/arm
 *     block_size=256
 *
 *   Or set environment variables:
 *     DDP_WSL_PATH=/home/youruser/ddp-portable/arm
 *     DDP_WSL_DISTRO=Ubuntu
 */

#ifdef _MSC_VER
#define _CRT_SECURE_NO_WARNINGS
#endif

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"

/* ── Constants ───────────────────────────────────────────────────────── */

#define DDP_UNIQUE_ID       0x44445031  /* 'DDP1' */
#define DDP_VERSION         100
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512         /* ~10.7ms at 48kHz */
#define MAX_BLOCK_SIZE      8192
#define READY_MAGIC         0xDD901DAA
#define CMD_SHUTDOWN        0xFFFFFFFF
#define CMD_PING            0xFFFFFFFD

/* ── Plugin State ────────────────────────────────────────────────────── */

typedef struct {
    /* WSL child process */
    HANDLE hProcess;
    HANDLE hStdinWrite;     /* write audio TO child */
    HANDLE hStdoutRead;     /* read processed audio FROM child */

    /* Audio buffers */
    int16_t* pcm_in;
    int16_t* pcm_out;

    /* State */
    int is_running;
    float sample_rate;
    int block_size;
    int bypass;

    /* Config */
    char wsl_distro[64];
    char ddp_path[512];
    char dll_dir[512];

    /* Host callback */
    audioMasterCallback master;
} DDPState;

/* ── Debug Logging ───────────────────────────────────────────────────── */

static void dbg(const char* fmt, ...) {
    char buf[1024];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    OutputDebugStringA(buf);
}

/* ── Pipe I/O ────────────────────────────────────────────────────────── */

static BOOL pipe_read_exact(HANDLE h, void* buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD bytes_read = 0;
        if (!ReadFile(h, (BYTE*)buf + total, n - total, &bytes_read, NULL)
            || bytes_read == 0)
            return FALSE;
        total += bytes_read;
    }
    return TRUE;
}

static BOOL pipe_write_exact(HANDLE h, const void* buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD bytes_written = 0;
        if (!WriteFile(h, (const BYTE*)buf + total, n - total,
                       &bytes_written, NULL) || bytes_written == 0)
            return FALSE;
        total += bytes_written;
    }
    return TRUE;
}

/* ── DLL Directory Helper ────────────────────────────────────────────── */

static void get_dll_directory(char* buf, size_t bufsize) {
    HMODULE hm = NULL;
    GetModuleHandleExA(
        GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
        GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        (LPCSTR)&get_dll_directory, &hm);
    GetModuleFileNameA(hm, buf, (DWORD)bufsize);
    char* last = strrchr(buf, '\\');
    if (last) *last = '\0';
}

/* ── Configuration ───────────────────────────────────────────────────── */

static void load_config(DDPState* st) {
    strcpy(st->wsl_distro, "Ubuntu");
    strcpy(st->ddp_path, "/home/user/ddp-portable/arm");

    /* Environment variables */
    const char* ep = getenv("DDP_WSL_PATH");
    if (ep && *ep) strncpy(st->ddp_path, ep, sizeof(st->ddp_path) - 1);
    const char* ed = getenv("DDP_WSL_DISTRO");
    if (ed && *ed) strncpy(st->wsl_distro, ed, sizeof(st->wsl_distro) - 1);

    /* INI file next to DLL */
    char ini[600];
    snprintf(ini, sizeof(ini), "%s\\ddp_config.ini", st->dll_dir);
    GetPrivateProfileStringA("DDP", "wsl_distro", st->wsl_distro,
                             st->wsl_distro, sizeof(st->wsl_distro), ini);
    GetPrivateProfileStringA("DDP", "ddp_path", st->ddp_path,
                             st->ddp_path, sizeof(st->ddp_path), ini);

    dbg("[DDP-VST] Config: distro=%s path=%s\n", st->wsl_distro, st->ddp_path);
}

/* ── WSL2 Process ────────────────────────────────────────────────────── */

static int start_wsl(DDPState* st) {
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE hChildStdinRead, hChildStdoutWrite;

    /* Create pipes with large buffers for low latency */
    if (!CreatePipe(&hChildStdinRead, &st->hStdinWrite, &sa, 256 * 1024) ||
        !CreatePipe(&st->hStdoutRead, &hChildStdoutWrite, &sa, 256 * 1024)) {
        dbg("[DDP-VST] CreatePipe failed: %lu\n", GetLastError());
        return -1;
    }

    SetHandleInformation(st->hStdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(st->hStdoutRead, HANDLE_FLAG_INHERIT, 0);

    /* Command line */
    char cmdline[2048];
    snprintf(cmdline, sizeof(cmdline),
        "wsl.exe -d %s -- bash -c \""
        "cd '%s' && "
        "LD_LIBRARY_PATH=build/lib "
        "qemu-arm-static -L /usr/arm-linux-gnueabihf "
        "build/ddp_processor build/lib/libdseffect.so 48000 -6 0"  /* profile 1 = music */
        "\"",
        st->wsl_distro, st->ddp_path);

    dbg("[DDP-VST] Launching: %s\n", cmdline);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput  = hChildStdinRead;
    si.hStdOutput = hChildStdoutWrite;
    si.hStdError  = GetStdHandle(STD_ERROR_HANDLE);

    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmdline, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        dbg("[DDP-VST] CreateProcess failed: %lu\n", GetLastError());
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

    /* Wait for ready magic */
    uint32_t magic = 0;
    if (!pipe_read_exact(st->hStdoutRead, &magic, sizeof(magic)) ||
        magic != READY_MAGIC) {
        dbg("[DDP-VST] No ready signal (got 0x%08X)\n", magic);
        TerminateProcess(st->hProcess, 1);
        CloseHandle(st->hProcess);
        CloseHandle(st->hStdinWrite);
        CloseHandle(st->hStdoutRead);
        return -1;
    }

    dbg("[DDP-VST] DDP processor ready!\n");
    st->is_running = 1;
    return 0;
}

static void stop_wsl(DDPState* st) {
    if (!st->is_running) return;

    /* Send shutdown command */
    uint32_t cmd = CMD_SHUTDOWN;
    pipe_write_exact(st->hStdinWrite, &cmd, sizeof(cmd));

    /* Wait up to 2 seconds then force kill */
    if (WaitForSingleObject(st->hProcess, 2000) == WAIT_TIMEOUT) {
        TerminateProcess(st->hProcess, 1);
    }

    CloseHandle(st->hStdinWrite);
    CloseHandle(st->hStdoutRead);
    CloseHandle(st->hProcess);
    st->is_running = 0;

    dbg("[DDP-VST] Process stopped\n");
}

/* ── VST Callbacks ───────────────────────────────────────────────────── */

static void ddp_processReplacing(struct AEffect* effect,
                                  float** inputs, float** outputs,
                                  int32_t sampleFrames) {
    DDPState* st = (DDPState*)effect->object;

    if (!st->is_running || st->bypass || sampleFrames <= 0) {
        /* Pass through */
        if (inputs[0] != outputs[0])
            memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        if (inputs[1] != outputs[1])
            memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    int frames = sampleFrames;
    if (frames > MAX_BLOCK_SIZE) frames = MAX_BLOCK_SIZE;

    /* Convert float → int16 interleaved */
    for (int i = 0; i < frames; i++) {
        float l = inputs[0][i];
        float r = inputs[1][i];

        /* Clamp to [-1, 1] */
        if (l >  1.0f) l =  1.0f;
        if (l < -1.0f) l = -1.0f;
        if (r >  1.0f) r =  1.0f;
        if (r < -1.0f) r = -1.0f;

        st->pcm_in[i * 2 + 0] = (int16_t)(l * 32767.0f);
        st->pcm_in[i * 2 + 1] = (int16_t)(r * 32767.0f);
    }

    /* Send frame count + PCM data */
    uint32_t fc = (uint32_t)frames;
    DWORD pcm_bytes = frames * 2 * sizeof(int16_t);

    if (!pipe_write_exact(st->hStdinWrite, &fc, sizeof(fc)) ||
        !pipe_write_exact(st->hStdinWrite, st->pcm_in, pcm_bytes)) {
        dbg("[DDP-VST] Write failed, switching to bypass\n");
        st->bypass = 1;
        memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    /* Read processed PCM */
    if (!pipe_read_exact(st->hStdoutRead, st->pcm_out, pcm_bytes)) {
        dbg("[DDP-VST] Read failed, switching to bypass\n");
        st->bypass = 1;
        memcpy(outputs[0], inputs[0], sampleFrames * sizeof(float));
        memcpy(outputs[1], inputs[1], sampleFrames * sizeof(float));
        return;
    }

    /* Convert int16 interleaved → float split channels */
    const float scale = 1.0f / 32767.0f;
    for (int i = 0; i < frames; i++) {
        outputs[0][i] = (float)st->pcm_out[i * 2 + 0] * scale;
        outputs[1][i] = (float)st->pcm_out[i * 2 + 1] * scale;
    }

    /* Zero any remaining frames if sampleFrames > MAX_BLOCK_SIZE */
    for (int i = frames; i < sampleFrames; i++) {
        outputs[0][i] = 0.0f;
        outputs[1][i] = 0.0f;
    }
}

static float ddp_getParameter(struct AEffect* effect, int32_t index) {
    DDPState* st = (DDPState*)effect->object;
    if (index == 0) return st->bypass ? 1.0f : 0.0f;
    return 0.0f;
}

static void ddp_setParameter(struct AEffect* effect, int32_t index, float value) {
    DDPState* st = (DDPState*)effect->object;
    if (index == 0) st->bypass = (value > 0.5f) ? 1 : 0;
}

static intptr_t ddp_dispatcher(struct AEffect* effect,
                                int32_t opcode, int32_t index,
                                intptr_t value, void* ptr, float opt) {
    DDPState* st = (DDPState*)effect->object;

    switch (opcode) {
    case effOpen:
        get_dll_directory(st->dll_dir, sizeof(st->dll_dir));
        load_config(st);

        st->pcm_in  = (int16_t*)calloc(MAX_BLOCK_SIZE * 2, sizeof(int16_t));
        st->pcm_out = (int16_t*)calloc(MAX_BLOCK_SIZE * 2, sizeof(int16_t));

        if (start_wsl(st) != 0) {
            dbg("[DDP-VST] WARNING: Failed to start processor. "
                "Plugin will bypass until restarted.\n");
            st->bypass = 1;
        }
        return 0;

    case effClose:
        stop_wsl(st);
        free(st->pcm_in);
        free(st->pcm_out);
        free(st);
        effect->object = NULL;
        return 0;

    case effSetSampleRate:
        st->sample_rate = opt;
        dbg("[DDP-VST] Sample rate: %.0f\n", opt);
        return 0;

    case effSetBlockSize:
        st->block_size = (int)value;
        dbg("[DDP-VST] Block size: %d\n", st->block_size);
        return 0;

    case effMainsChanged:
        /* value=1 means resume, value=0 means suspend */
        return 0;

    case effGetEffectName:
        strcpy((char*)ptr, "Dolby DDP");
        return 1;

    case effGetVendorString:
        strcpy((char*)ptr, "DDP-Portable");
        return 1;

    case effGetProductString:
        strcpy((char*)ptr, "Dolby Digital Plus Bridge");
        return 1;

    case effGetVendorVersion:
        return DDP_VERSION;

    case effGetVstVersion:
        return kVstVersion;

    case effGetPlugCategory:
        return kPlugCategEffect;

    case effCanDo:
        if (ptr) {
            if (strcmp((char*)ptr, "receiveVstEvents") == 0) return -1;
            if (strcmp((char*)ptr, "receiveVstMidiEvent") == 0) return -1;
        }
        return 0;

    case effGetParamName:
    case effGetParamLabel:
    case effGetParamDisplay:
        if (index == 0 && ptr) {
            strcpy((char*)ptr, opcode == effGetParamDisplay
                ? (st->bypass ? "ON" : "OFF") : "Bypass");
            return 1;
        }
        return 0;

    default:
        return 0;
    }
}

/* ── VST Entry Point ─────────────────────────────────────────────────── */

#ifdef __cplusplus
extern "C" {
#endif

VST_EXPORT struct AEffect* VSTPluginMain(audioMasterCallback audioMaster) {
    if (!audioMaster) return NULL;

    /* Verify host VST version */
    if (audioMaster(NULL, audioMasterVersion, 0, 0, NULL, 0.0f) == 0)
        return NULL;

    DDPState* st = (DDPState*)calloc(1, sizeof(DDPState));
    if (!st) return NULL;
    st->master = audioMaster;
    st->sample_rate = 48000.0f;
    st->block_size = 256;

    struct AEffect* effect = (struct AEffect*)calloc(1, sizeof(struct AEffect));
    if (!effect) { free(st); return NULL; }

    effect->magic = 0x56737450;  /* 'VstP' */
    effect->dispatcher = ddp_dispatcher;
    effect->process_deprecated = NULL;
    effect->setParameter = ddp_setParameter;
    effect->getParameter = ddp_getParameter;
    effect->numPrograms = 1;
    effect->numParams = 1;  /* bypass toggle */
    effect->numInputs = DDP_NUM_CHANNELS;
    effect->numOutputs = DDP_NUM_CHANNELS;
    effect->flags = effFlagsCanReplacing;
    effect->initialDelay = DDP_LATENCY_SAMPLES;
    effect->object = st;
    effect->uniqueID = DDP_UNIQUE_ID;
    effect->version = DDP_VERSION;
    effect->processReplacing = ddp_processReplacing;
    effect->processDoubleReplacing = NULL;

    return effect;
}

/* Some hosts look for 'main' instead of 'VSTPluginMain' */
VST_EXPORT struct AEffect* main_entry(audioMasterCallback audioMaster) {
    return VSTPluginMain(audioMaster);
}

#ifdef __cplusplus
}
#endif

/* ── DLL Entry Point ─────────────────────────────────────────────────── */

BOOL WINAPI DllMain(HINSTANCE hInst, DWORD reason, LPVOID reserved) {
    (void)hInst; (void)reserved;
    return TRUE;
}
