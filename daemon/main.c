/*
 * daemon/main.c — DolbyX Daemon
 *
 * Central background process for DolbyX. Manages the DDP ARM processor
 * and provides two communication channels:
 *
 *   \\.\pipe\DolbyX      — audio (VST plugin connects here)
 *   HTTP localhost:9876   — Web UI + WebSocket control
 *
 * Build (Windows, MinGW):
 *   x86_64-w64-mingw32-gcc -O2 -o dolbyx.exe main.c http.c \
 *     -static -ladvapi32 -lws2_32
 */

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "http.h"
#include "ddp_protocol.h"

#define PIPE_AUDIO      "\\\\.\\pipe\\DolbyX"
#define READY_MAGIC     0xDD901DAA
#define CMD_SHUTDOWN    0xFFFFFFFF
#define CHUNK_SIZE      256
#define MAX_FRAMES      131072
#define MAX_SESSIONS    8

/* ── Profile defaults ─────────────────────────────────────────────── */

const int16_t g_profiles[DDP_PROFILE_COUNT][DDP_PARAM_COUNT] = {
    [DDP_PROFILE_MOVIE] = {2,2,96,96,200,2,7,0,0,0,10,1,3,0,4,2,144,0,0,0},
    [DDP_PROFILE_MUSIC] = {2,2,48,0,200,2,4,0,0,0,10,1,2,0,4,2,144,0,0,0},
    [DDP_PROFILE_GAME]  = {2,2,0,0,200,2,0,1,0,0,10,0,7,0,4,2,144,2,0,0},
    [DDP_PROFILE_VOICE] = {2,0,0,0,200,2,0,0,0,0,10,1,10,0,4,2,144,0,0,0},
    [DDP_PROFILE_USER1] = {2,0,48,48,200,2,5,0,0,0,10,0,7,0,4,2,144,2,0,0},
    [DDP_PROFILE_USER2] = {2,0,48,48,200,2,5,0,0,0,10,0,7,0,4,2,144,2,0,0},
    [DDP_PROFILE_OFF]   = {2,0,0,0,200,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0},
};

/* ── Logging ──────────────────────────────────────────────────────── */

CRITICAL_SECTION g_log_lock;

void log_msg(const char *fmt, ...) {
    EnterCriticalSection(&g_log_lock);
    SYSTEMTIME t; GetLocalTime(&t);
    printf("[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a; va_start(a, fmt); vprintf(fmt, a); va_end(a);
    fflush(stdout);
    LeaveCriticalSection(&g_log_lock);
}

/* ── Pipe I/O ─────────────────────────────────────────────────────── */

static BOOL read_exact(HANDLE h, void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) { DWORD r = 0;
        if (!ReadFile(h, (BYTE*)buf+t, n-t, &r, NULL) || !r) return FALSE;
        t += r; }
    return TRUE;
}

static BOOL write_exact(HANDLE h, const void *buf, DWORD n) {
    DWORD t = 0;
    while (t < n) { DWORD w = 0;
        if (!WriteFile(h, (const BYTE*)buf+t, n-t, &w, NULL) || !w) return FALSE;
        t += w; }
    return TRUE;
}

/* ── Processor ────────────────────────────────────────────────────── */

typedef struct {
    HANDLE process, stdin_wr, stdout_rd;
    CRITICAL_SECTION lock;
} Proc;

static const char *g_wsl_path = NULL;

static Proc *proc_start(void) {
    Proc *p = (Proc *)calloc(1, sizeof(Proc));
    InitializeCriticalSection(&p->lock);
    SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
    HANDLE si_r, so_w;
    if (!CreatePipe(&si_r, &p->stdin_wr, &sa, 4*1024*1024) ||
        !CreatePipe(&p->stdout_rd, &so_w, &sa, 4*1024*1024)) {
        DeleteCriticalSection(&p->lock); free(p); return NULL;
    }
    SetHandleInformation(p->stdin_wr, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(p->stdout_rd, HANDLE_FLAG_INHERIT, 0);

    char cmd[2048];
    snprintf(cmd, sizeof(cmd),
        "wsl.exe -- bash -c \""
        "cd '%s' && LD_LIBRARY_PATH=build/lib "
        "qemu-arm-static -L /usr/arm-linux-gnueabihf "
        "build/ddp_processor build/lib/libdseffect.so 48000\"",
        g_wsl_path);

    STARTUPINFOA si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = si_r; si.hStdOutput = so_w;
    si.hStdError = INVALID_HANDLE_VALUE;
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(si_r); CloseHandle(so_w);
        CloseHandle(p->stdin_wr); CloseHandle(p->stdout_rd);
        DeleteCriticalSection(&p->lock); free(p); return NULL;
    }
    CloseHandle(si_r); CloseHandle(so_w);
    p->process = pi.hProcess; CloseHandle(pi.hThread);

    DWORD magic = 0;
    if (!read_exact(p->stdout_rd, &magic, 4) || magic != READY_MAGIC) {
        TerminateProcess(p->process, 1);
        CloseHandle(p->process); CloseHandle(p->stdin_wr); CloseHandle(p->stdout_rd);
        DeleteCriticalSection(&p->lock); free(p); return NULL;
    }
    return p;
}

static void proc_stop(Proc *p) {
    if (!p) return;
    DWORD cmd = CMD_SHUTDOWN;
    write_exact(p->stdin_wr, &cmd, 4);
    if (WaitForSingleObject(p->process, 2000) == WAIT_TIMEOUT)
        TerminateProcess(p->process, 1);
    CloseHandle(p->process); CloseHandle(p->stdin_wr); CloseHandle(p->stdout_rd);
    DeleteCriticalSection(&p->lock); free(p);
}

/* ── Global processor registry ────────────────────────────────────── */

Proc *g_procs[MAX_SESSIONS];
CRITICAL_SECTION g_procs_lock;

static void reg_proc(Proc *p) {
    EnterCriticalSection(&g_procs_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (!g_procs[i]) { g_procs[i] = p; break; }
    LeaveCriticalSection(&g_procs_lock);
}

static void unreg_proc(Proc *p) {
    EnterCriticalSection(&g_procs_lock);
    for (int i = 0; i < MAX_SESSIONS; i++)
        if (g_procs[i] == p) { g_procs[i] = NULL; break; }
    LeaveCriticalSection(&g_procs_lock);
}

BOOL proc_ctrl(Proc *p, const BYTE *data, int dlen,
               BYTE *reply, int rlen) {
    EnterCriticalSection(&p->lock);
    BOOL ok = write_exact(p->stdin_wr, data, dlen);
    if (ok && reply && rlen > 0)
        ok = read_exact(p->stdout_rd, reply, rlen);
    LeaveCriticalSection(&p->lock);
    return ok;
}

/* ── Pipe security ────────────────────────────────────────────────── */

static SECURITY_ATTRIBUTES *get_sa(void) {
    static SECURITY_DESCRIPTOR sd;
    static SECURITY_ATTRIBUTES sa;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE);
    sa.nLength = sizeof(sa); sa.lpSecurityDescriptor = &sd; sa.bInheritHandle = FALSE;
    return &sa;
}

/* ── Control command sizes ────────────────────────────────────────── */

static int ctrl_extra(DWORD cmd, int *reply_len) {
    *reply_len = 4;
    switch (cmd) {
    case 0xFFFFFFF0: return 4;  /* SET_PARAM */
    case 0xFFFFFFF1: return 4;  /* SET_PROFILE */
    case 0xFFFFFFF2: *reply_len = 40; return 0; /* GET_VIS */
    case 0xFFFFFFFD: return 0;  /* PING */
    case 0xFFFFFFEF: return 4;  /* SET_IEQ_PRESET */
    default: return -1;
    }
}

/* ── Apply saved state to a new processor ─────────────────────────── */

static void apply_saved_state(Proc *proc) {
    extern int g_current_profile;
    extern int g_current_power;
    extern int16_t g_current_params[];
    extern int g_current_ieq;

    /* Set profile */
    BYTE pkt[8]; BYTE reply[4];
    DWORD cmd = DDP_CMD_SET_PROFILE;
    DWORD pid = (DWORD)g_current_profile;
    memcpy(pkt, &cmd, 4); memcpy(pkt+4, &pid, 4);
    proc_ctrl(proc, pkt, 8, reply, 4);

    /* Apply param overrides */
    for (int i = 1; i < DDP_PARAM_COUNT; i++) {
        if (g_current_params[i] != g_profiles[g_current_profile][i]) {
            cmd = DDP_CMD_SET_PARAM;
            uint16_t pi = (uint16_t)i;
            int16_t v = g_current_params[i];
            memcpy(pkt, &cmd, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
            proc_ctrl(proc, pkt, 8, reply, 4);
        }
    }

    /* Apply IEQ preset */
    if (g_current_ieq != DDP_IEQ_MANUAL && g_current_ieq >= 0 && g_current_ieq <= 2) {
        cmd = DDP_CMD_SET_PARAM;
        uint16_t pi = DDP_PARAM_IEON; int16_t v = 1;
        memcpy(pkt, &cmd, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
        proc_ctrl(proc, pkt, 8, reply, 4);

        pi = DDP_PARAM_IEA; v = 10;
        memcpy(pkt, &cmd, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
        proc_ctrl(proc, pkt, 8, reply, 4);

        cmd = DDP_CMD_SET_IEQ_PRESET;
        DWORD preset = (DWORD)g_current_ieq;
        memcpy(pkt, &cmd, 4); memcpy(pkt+4, &preset, 4);
        proc_ctrl(proc, pkt, 8, reply, 4);
    }

    /* Power off → OFF profile */
    if (!g_current_power) {
        cmd = DDP_CMD_SET_PROFILE;
        pid = DDP_PROFILE_OFF;
        memcpy(pkt, &cmd, 4); memcpy(pkt+4, &pid, 4);
        proc_ctrl(proc, pkt, 8, reply, 4);
    }

    log_msg("Applied saved state: profile=%d power=%d ieq=%d\n",
            g_current_profile, g_current_power, g_current_ieq);
}

/* ── Audio client thread ──────────────────────────────────────────── */

typedef struct { HANDLE pipe; int sid; } ClientArgs;

static DWORD WINAPI audio_thread(LPVOID param) {
    ClientArgs *a = (ClientArgs *)param;
    HANDLE pipe = a->pipe; int sid = a->sid; free(a);

    log_msg("Audio %d: starting processor\n", sid);
    Proc *proc = proc_start();
    if (!proc) {
        log_msg("Audio %d: failed\n", sid);
        DisconnectNamedPipe(pipe); CloseHandle(pipe); return 1;
    }
    log_msg("Audio %d: ready\n", sid);
    reg_proc(proc);

    /* Apply daemon's current state to the new processor */
    apply_saved_state(proc);

    DWORD magic = READY_MAGIC;
    write_exact(pipe, &magic, 4);

    BYTE *buf = (BYTE *)malloc(MAX_FRAMES * 4);
    int blocks = 0;

    for (;;) {
        DWORD fc = 0;
        if (!read_exact(pipe, &fc, 4)) break;
        if (fc == CMD_SHUTDOWN) break;

        /* Control commands from audio pipe (inline forwarding) */
        if (fc >= 0xFFFFFFE0) {
            int rlen = 0;
            int extra = ctrl_extra(fc, &rlen);
            if (extra < 0) continue;
            BYTE pkt[16]; memcpy(pkt, &fc, 4);
            if (extra > 0 && !read_exact(pipe, pkt+4, extra)) break;
            BYTE reply[40] = {0};
            proc_ctrl(proc, pkt, 4+extra, reply, rlen);
            write_exact(pipe, reply, rlen);
            continue;
        }

        /* Audio processing */
        if (fc > MAX_FRAMES) break;
        DWORD bytes = fc * 4;
        if (!read_exact(pipe, buf, bytes)) break;

        EnterCriticalSection(&proc->lock);
        DWORD off = 0; BOOL ok = TRUE;
        while (off < fc && ok) {
            DWORD ch = fc - off; if (ch > CHUNK_SIZE) ch = CHUNK_SIZE;
            if (!write_exact(proc->stdin_wr, &ch, 4) ||
                !write_exact(proc->stdin_wr, buf + off*4, ch*4)) ok = FALSE;
            off += ch;
        }
        if (ok) {
            off = 0;
            while (off < fc) {
                DWORD ch = fc - off; if (ch > CHUNK_SIZE) ch = CHUNK_SIZE;
                if (!read_exact(proc->stdout_rd, buf + off*4, ch*4)) { ok = FALSE; break; }
                off += ch;
            }
        }
        LeaveCriticalSection(&proc->lock);
        if (!ok) break;
        if (!write_exact(pipe, buf, bytes)) break;

        blocks++;
        if (blocks <= 3 || blocks % 5000 == 0)
            log_msg("Audio %d: block %d (%u frames)\n", sid, blocks, fc);
    }

    unreg_proc(proc);
    log_msg("Audio %d: done (%d blocks)\n", sid, blocks);
    free(buf); proc_stop(proc);
    DisconnectNamedPipe(pipe); CloseHandle(pipe);
    return 0;
}

/* ── Audio pipe accept thread ─────────────────────────────────────── */

static DWORD WINAPI accept_audio(LPVOID param) {
    SECURITY_ATTRIBUTES *sa = get_sa();
    int sid = 0;
    for (;;) {
        HANDLE p = CreateNamedPipeA(PIPE_AUDIO, PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES, 4*1024*1024, 4*1024*1024, 0, sa);
        if (p == INVALID_HANDLE_VALUE) { Sleep(1000); continue; }
        if (!ConnectNamedPipe(p, NULL) && GetLastError() != ERROR_PIPE_CONNECTED)
            { CloseHandle(p); continue; }
        sid++;
        ClientArgs *a = malloc(sizeof(ClientArgs));
        a->pipe = p; a->sid = sid;
        HANDLE t = CreateThread(NULL, 0, audio_thread, a, 0, NULL);
        if (t) CloseHandle(t);
        else { free(a); DisconnectNamedPipe(p); CloseHandle(p); }
    }
    return 0;
}

/* ── Main ─────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    WSADATA wd;
    WSAStartup(MAKEWORD(2, 2), &wd);
    InitializeCriticalSection(&g_log_lock);
    InitializeCriticalSection(&g_procs_lock);

    printf("DolbyX Daemon v2.0\n==================\n\n");
    if (argc < 2) {
        printf("Usage: dolbyx <wsl-path-to-DolbyX/arm>\n");
        return 1;
    }
    g_wsl_path = argv[1];
    log_msg("Path: %s\n", g_wsl_path);

    log_msg("Smoke test...\n");
    Proc *test = proc_start();
    if (!test) { log_msg("FATAL: cannot start processor\n"); return 1; }
    proc_stop(test);
    log_msg("OK\n\n");

    /* Start servers */
    HANDLE t1 = CreateThread(NULL, 0, accept_audio, NULL, 0, NULL);
    http_start();

    log_msg("DolbyX running -> http://localhost:9876\n\n");

    WaitForSingleObject(t1, INFINITE);
    WSACleanup();
    return 0;
}
