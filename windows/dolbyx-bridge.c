/*
 * dolbyx-bridge.c — DolbyX Named Pipe Bridge (Multi-client + Control)
 *
 * Two named pipes:
 *   \\.\pipe\DolbyX     — audio (audiodg.exe connects here)
 *   \\.\pipe\DolbyXCtrl — control commands (Editor UI connects here)
 *
 * Control commands are forwarded to ALL active audio processors.
 *
 * Build:
 *   x86_64-w64-mingw32-gcc -O2 -o dolbyx-bridge.exe dolbyx-bridge.c \
 *     -static -ladvapi32
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIPE_AUDIO      "\\\\.\\pipe\\DolbyX"
#define PIPE_CTRL       "\\\\.\\pipe\\DolbyXCtrl"
#define READY_MAGIC     0xDD901DAA
#define CMD_SHUTDOWN    0xFFFFFFFF
#define CHUNK_SIZE      256
#define MAX_FRAMES      131072
#define MAX_SESSIONS    8

static CRITICAL_SECTION g_log_lock;

static void log_msg(const char *fmt, ...) {
    EnterCriticalSection(&g_log_lock);
    SYSTEMTIME t; GetLocalTime(&t);
    printf("[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a; va_start(a, fmt); vprintf(fmt, a); va_end(a);
    fflush(stdout);
    LeaveCriticalSection(&g_log_lock);
}

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
    Proc *p = (Proc*)calloc(1, sizeof(Proc));
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

static Proc *g_procs[MAX_SESSIONS];
static CRITICAL_SECTION g_procs_lock;

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

/* Send a control command to one processor (thread-safe) */
static BOOL proc_ctrl(Proc *p, const BYTE *data, int dlen,
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

/* ── Control command: determine payload sizes ─────────────────────── */
/*
 * Returns extra bytes to read after the 4-byte command header,
 * and sets *reply_len to the expected response size.
 */
static int ctrl_extra(DWORD cmd, int *reply_len) {
    *reply_len = 4;
    switch (cmd) {
    case 0xFFFFFFF0: return 4;  /* SET_PARAM: +uint16 idx + int16 val → uint32 */
    case 0xFFFFFFF1: return 4;  /* SET_PROFILE: +uint32 pid → uint32 */
    case 0xFFFFFFF2: *reply_len = 40; return 0; /* GET_VIS: → int16[20] */
    case 0xFFFFFFFD: return 0;  /* PING: → uint32 */
    case 0xFFFFFFEF: return 4;  /* SET_IEQ_PRESET: +uint32 pid → uint32 */
    case 0xFFFFFFED: return 4;  /* SET_POWER: +uint32 power → uint32 */
    default: return -1;         /* unknown */
    }
}

/* ── Audio client thread ──────────────────────────────────────────── */

typedef struct { HANDLE pipe; int sid; } ClientArgs;

static DWORD WINAPI audio_thread(LPVOID param) {
    ClientArgs *a = (ClientArgs*)param;
    HANDLE pipe = a->pipe; int sid = a->sid; free(a);

    log_msg("Audio %d: starting processor\n", sid);
    Proc *proc = proc_start();
    if (!proc) {
        log_msg("Audio %d: failed\n", sid);
        DisconnectNamedPipe(pipe); CloseHandle(pipe); return 1;
    }
    log_msg("Audio %d: ready\n", sid);
    reg_proc(proc);

    DWORD magic = READY_MAGIC;
    write_exact(pipe, &magic, 4);

    BYTE *buf = (BYTE*)malloc(MAX_FRAMES * 4);
    int blocks = 0;

    for (;;) {
        DWORD fc = 0;
        if (!read_exact(pipe, &fc, 4)) break;
        if (fc == CMD_SHUTDOWN) break;

        /* Control commands */
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

        /* Audio */
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
                if (!read_exact(proc->stdout_rd, buf + off*4, ch*4)) { ok=FALSE; break; }
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

/* ── Control client thread ────────────────────────────────────────── */

static DWORD WINAPI ctrl_thread(LPVOID param) {
    HANDLE pipe = (HANDLE)param;
    log_msg("Control connected\n");

    DWORD magic = READY_MAGIC;
    write_exact(pipe, &magic, 4);

    for (;;) {
        DWORD cmd = 0;
        if (!read_exact(pipe, &cmd, 4)) break;
        if (cmd == CMD_SHUTDOWN) break;

        int rlen = 0;
        int extra = ctrl_extra(cmd, &rlen);
        if (extra < 0) continue;

        BYTE pkt[16]; memcpy(pkt, &cmd, 4);
        if (extra > 0 && !read_exact(pipe, pkt+4, extra)) break;

        /* Forward to ALL active audio processors */
        BYTE reply[40] = {0};
        BOOL any = FALSE;

        EnterCriticalSection(&g_procs_lock);
        for (int i = 0; i < MAX_SESSIONS; i++) {
            if (!g_procs[i]) continue;
            if (proc_ctrl(g_procs[i], pkt, 4+extra, reply, rlen))
                any = TRUE;
        }
        LeaveCriticalSection(&g_procs_lock);

        if (!any) memset(reply, 0xFF, rlen);
        write_exact(pipe, reply, rlen);
    }

    log_msg("Control disconnected\n");
    DisconnectNamedPipe(pipe); CloseHandle(pipe);
    return 0;
}

/* ── Accept threads ───────────────────────────────────────────────── */

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
        if (t) CloseHandle(t); else { free(a); DisconnectNamedPipe(p); CloseHandle(p); }
    }
    return 0;
}

static DWORD WINAPI accept_ctrl(LPVOID param) {
    SECURITY_ATTRIBUTES *sa = get_sa();
    for (;;) {
        HANDLE p = CreateNamedPipeA(PIPE_CTRL, PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES, 64*1024, 64*1024, 0, sa);
        if (p == INVALID_HANDLE_VALUE) { Sleep(1000); continue; }
        if (!ConnectNamedPipe(p, NULL) && GetLastError() != ERROR_PIPE_CONNECTED)
            { CloseHandle(p); continue; }
        HANDLE t = CreateThread(NULL, 0, ctrl_thread, p, 0, NULL);
        if (t) CloseHandle(t); else { DisconnectNamedPipe(p); CloseHandle(p); }
    }
    return 0;
}

/* ── Main ─────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    InitializeCriticalSection(&g_log_lock);
    InitializeCriticalSection(&g_procs_lock);

    printf("DolbyX Bridge v1.3\n==================\n\n");
    if (argc < 2) {
        printf("Usage: dolbyx-bridge.exe <wsl-path-to-DolbyX/arm>\n");
        return 1;
    }
    g_wsl_path = argv[1];
    log_msg("Path: %s\n", g_wsl_path);

    log_msg("Smoke test...\n");
    Proc *test = proc_start();
    if (!test) { log_msg("FATAL\n"); return 1; }
    proc_stop(test);
    log_msg("OK\n\n");

    HANDLE t1 = CreateThread(NULL, 0, accept_audio, NULL, 0, NULL);
    HANDLE t2 = CreateThread(NULL, 0, accept_ctrl, NULL, 0, NULL);
    log_msg("Listening (Ctrl+C to stop)\n\n");

    WaitForSingleObject(t1, INFINITE);
    WaitForSingleObject(t2, INFINITE);
    return 0;
}
