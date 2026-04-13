/*
 * ddp_vst.c — DolbyX VST2 Bridge (TCP daemon mode)
 *
 * Connects to the DolbyX daemon running in WSL2 via TCP localhost.
 * The daemon handles QEMU/ARM processing; the VST just pipes audio.
 *
 * The user starts the daemon manually:
 *   cd ~/DolbyX/arm && python3 ../scripts/dolbyx-daemon.py
 *
 * Build: x86_64-w64-mingw32-gcc -shared -O2 -o DolbyDDP.dll ddp_vst.c -lws2_32 -static
 */

#ifdef _MSC_VER
#define _CRT_SECURE_NO_WARNINGS
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vst2_abi.h"

#pragma comment(lib, "ws2_32.lib")

#define DDP_UNIQUE_ID       0x44445031
#define DDP_VERSION         130
#define DDP_NUM_CHANNELS    2
#define DDP_LATENCY_SAMPLES 512
#define CHUNK_SIZE          256
#define READY_MAGIC         0xDD901DAA
#define CMD_SHUTDOWN        0xFFFFFFFF
#define DEFAULT_PORT        19876

typedef struct {
    SOCKET sock;
    int16_t pcm_in[CHUNK_SIZE * 2];
    int16_t pcm_out[CHUNK_SIZE * 2];
    int connected;
    int bypass;
    int block_count;
    float sample_rate;
    int port;
    char dll_dir[512];
    FILE* logfp;
    audioMasterCallback master;
} DDPState;

/* ── Logging ─────────────────────────────────────────────────────── */

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

/* ── TCP I/O ─────────────────────────────────────────────────────── */

static BOOL tcp_send(SOCKET s, const void* buf, int n) {
    const char* p = (const char*)buf;
    int total = 0;
    while (total < n) {
        int sent = send(s, p + total, n - total, 0);
        if (sent <= 0) return FALSE;
        total += sent;
    }
    return TRUE;
}

static BOOL tcp_recv(SOCKET s, void* buf, int n) {
    char* p = (char*)buf;
    int total = 0;
    while (total < n) {
        int got = recv(s, p + total, n - total, 0);
        if (got <= 0) return FALSE;
        total += got;
    }
    return TRUE;
}

/* ── DLL Directory ───────────────────────────────────────────────── */

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

/* ── Config ──────────────────────────────────────────────────────── */

static void load_config(DDPState* st) {
    st->port = DEFAULT_PORT;
    char ini[600];
    snprintf(ini, sizeof(ini), "%s\\ddp_config.ini", st->dll_dir);
    st->port = GetPrivateProfileIntA("DDP", "port", DEFAULT_PORT, ini);
    logf_(st, "Config: port=%d ini=%s\n", st->port, ini);
}

/* ── Connect to daemon ───────────────────────────────────────────── */

static int connect_daemon(DDPState* st) {
    if (st->connected) return 0;

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((u_short)st->port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    st->sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (st->sock == INVALID_SOCKET) {
        logf_(st, "socket() failed: %d\n", WSAGetLastError());
        return -1;
    }

    /* TCP_NODELAY for low latency */
    int flag = 1;
    setsockopt(st->sock, IPPROTO_TCP, TCP_NODELAY, (const char*)&flag, sizeof(flag));

    /* Set socket buffer sizes */
    int bufsize = 256 * 1024;
    setsockopt(st->sock, SOL_SOCKET, SO_SNDBUF, (const char*)&bufsize, sizeof(bufsize));
    setsockopt(st->sock, SOL_SOCKET, SO_RCVBUF, (const char*)&bufsize, sizeof(bufsize));

    logf_(st, "Connecting to localhost:%d...\n", st->port);

    if (connect(st->sock, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        logf_(st, "connect() failed: %d — Is dolbyx-daemon running?\n",
              WSAGetLastError());
        closesocket(st->sock);
        st->sock = INVALID_SOCKET;
        return -1;
    }

    /* Read ready magic */
    uint32_t magic = 0;
    if (!tcp_recv(st->sock, &magic, sizeof(magic)) || magic != READY_MAGIC) {
        logf_(st, "Bad magic: 0x%08X\n", magic);
        closesocket(st->sock);
        st->sock = INVALID_SOCKET;
        return -1;
    }

    logf_(st, "Connected! DDP processor ready.\n");
    st->connected = 1;
    st->bypass = 0;
    st->block_count = 0;
    return 0;
}

static void disconnect_daemon(DDPState* st) {
    if (!st->connected) return;
    uint32_t cmd = CMD_SHUTDOWN;
    tcp_send(st->sock, &cmd, sizeof(cmd));
    closesocket(st->sock);
    st->sock = INVALID_SOCKET;
    st->connected = 0;
    logf_(st, "Disconnected after %d blocks\n", st->block_count);
}

/* ── processReplacing ────────────────────────────────────────────── */

static void ddp_processReplacing(struct AEffect* effect,
                                  float** inputs, float** outputs,
                                  int32_t sampleFrames) {
    DDPState* st = (DDPState*)effect->object;

    /* Lazy connect */
    if (!st->connected && !st->bypass) {
        if (connect_daemon(st) != 0) {
            logf_(st, "Cannot connect to daemon — bypass\n");
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

    /* Process in CHUNK_SIZE pieces */
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
        int pcm_bytes = chunk * 2 * sizeof(int16_t);

        if (!tcp_send(st->sock, &fc, sizeof(fc)) ||
            !tcp_send(st->sock, st->pcm_in, pcm_bytes)) {
            logf_(st, "Send failed at block %d offset %d\n",
                  st->block_count, offset);
            st->connected = 0;
            st->bypass = 1;
            for (int i = offset; i < sampleFrames; i++) {
                outputs[0][i] = inputs[0][i];
                outputs[1][i] = inputs[1][i];
            }
            return;
        }

        if (!tcp_recv(st->sock, st->pcm_out, pcm_bytes)) {
            logf_(st, "Recv failed at block %d offset %d\n",
                  st->block_count, offset);
            st->connected = 0;
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
              st->block_count, sampleFrames,
              (sampleFrames + CHUNK_SIZE - 1) / CHUNK_SIZE);
}

/* ── Parameter ───────────────────────────────────────────────────── */

static float ddp_getParam(struct AEffect* e, int32_t i) {
    DDPState* st = (DDPState*)e->object;
    return (i == 0 && st) ? (st->bypass ? 1.0f : 0.0f) : 0.0f;
}
static void ddp_setParam(struct AEffect* e, int32_t i, float v) {
    DDPState* st = (DDPState*)e->object;
    if (i == 0 && st) {
        int newval = (v > 0.5f) ? 1 : 0;
        if (newval && !st->bypass) disconnect_daemon(st);
        st->bypass = newval;
    }
}

/* ── Dispatcher ──────────────────────────────────────────────────── */

static intptr_t ddp_dispatch(struct AEffect* effect,
    int32_t opcode, int32_t index, intptr_t value, void* ptr, float opt) {
    DDPState* st = (DDPState*)effect->object;
    switch (opcode) {
    case effOpen: {
        WSADATA wd; WSAStartup(MAKEWORD(2,2), &wd);
        get_dll_dir(st->dll_dir, sizeof(st->dll_dir));
        char lp[600];
        snprintf(lp, sizeof(lp), "%s\\DolbyDDP.log", st->dll_dir);
        st->logfp = fopen(lp, "a");
        logf_(st, "\n===== DolbyX VST opened (TCP mode) =====\n");
        load_config(st);
        if (connect_daemon(st) != 0)
            logf_(st, "effOpen: daemon not running, will retry lazily\n");
        return 0;
    }
    case effClose:
        logf_(st, "effClose: blocks=%d\n", st ? st->block_count : -1);
        disconnect_daemon(st);
        if (st->logfp) fclose(st->logfp);
        WSACleanup();
        free(st); effect->object = NULL;
        return 0;
    case effSetSampleRate:
        if (st) { st->sample_rate = opt; logf_(st, "SampleRate: %.0f\n", opt); }
        return 0;
    case effSetBlockSize:
        if (st) logf_(st, "BlockSize: %d\n", (int)value);
        return 0;
    case effMainsChanged:
        if (st) logf_(st, "MainsChanged: %d\n", (int)value);
        /* Reconnect on resume if needed */
        if (value && st && !st->connected && !st->bypass)
            connect_daemon(st);
        return 0;
    case effGetEffectName:
        strcpy((char*)ptr, "DolbyX DDP"); return 1;
    case effGetVendorString:
        strcpy((char*)ptr, "DolbyX"); return 1;
    case effGetProductString:
        strcpy((char*)ptr, "Dolby Digital Plus Bridge"); return 1;
    case effGetVendorVersion: return DDP_VERSION;
    case effGetVstVersion: return kVstVersion;
    case effGetPlugCategory: return kPlugCategEffect;
    case effCanDo:
        if (ptr && st) logf_(st, "CanDo: %s\n", (char*)ptr);
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
    st->master = audioMaster;
    st->sample_rate = 48000.0f;
    st->sock = INVALID_SOCKET;
    struct AEffect* e = (struct AEffect*)calloc(1, sizeof(struct AEffect));
    if (!e) { free(st); return NULL; }
    e->magic = 0x56737450;
    e->dispatcher = ddp_dispatch;
    e->setParameter = ddp_setParam;
    e->getParameter = ddp_getParam;
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
VST_EXPORT struct AEffect* main_entry(audioMasterCallback m) { return VSTPluginMain(m); }

#ifdef __cplusplus
}
#endif

BOOL WINAPI DllMain(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p; return TRUE;
}
