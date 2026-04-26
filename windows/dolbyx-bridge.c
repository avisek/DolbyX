/*
 * dolbyx-bridge.c — DolbyX Named Pipe Bridge (Multi-client)
 *
 * Creates \\.\pipe\DolbyX with permissive ACL for audiodg.exe.
 * Each client gets its own DDP processor in a separate thread.
 * Handles multiple simultaneous connections (editor preview,
 * editor analysis, and audiodg.exe all connect at once).
 *
 * Build:
 *   x86_64-w64-mingw32-gcc -O2 -o dolbyx-bridge.exe dolbyx-bridge.c \
 *     -static -ladvapi32
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIPE_NAME       "\\\\.\\pipe\\DolbyX"
#define READY_MAGIC     0xDD901DAA
#define CMD_SHUTDOWN    0xFFFFFFFF
#define CHUNK_SIZE      256
#define MAX_FRAMES      131072

/* ── Logging ──────────────────────────────────────────────────────── */

static CRITICAL_SECTION g_log_lock;

static void log_msg(const char *fmt, ...) {
    EnterCriticalSection(&g_log_lock);
    SYSTEMTIME t;
    GetLocalTime(&t);
    printf("[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a;
    va_start(a, fmt);
    vprintf(fmt, a);
    va_end(a);
    fflush(stdout);
    LeaveCriticalSection(&g_log_lock);
}

/* ── Exact I/O ────────────────────────────────────────────────────── */

static BOOL read_exact(HANDLE h, void *buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD r = 0;
        if (!ReadFile(h, (BYTE *)buf + total, n - total, &r, NULL) || r == 0)
            return FALSE;
        total += r;
    }
    return TRUE;
}

static BOOL write_exact(HANDLE h, const void *buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD w = 0;
        if (!WriteFile(h, (const BYTE *)buf + total, n - total, &w, NULL) || w == 0)
            return FALSE;
        total += w;
    }
    return TRUE;
}

/* ── DDP Processor ────────────────────────────────────────────────── */

typedef struct {
    HANDLE process;
    HANDLE stdin_wr;
    HANDLE stdout_rd;
} Processor;

static const char *g_wsl_path = NULL;

static Processor *processor_start(void) {
    Processor *p = (Processor *)calloc(1, sizeof(Processor));
    SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
    HANDLE stdin_rd, stdout_wr;

    if (!CreatePipe(&stdin_rd, &p->stdin_wr, &sa, 4 * 1024 * 1024) ||
        !CreatePipe(&p->stdout_rd, &stdout_wr, &sa, 4 * 1024 * 1024)) {
        free(p);
        return NULL;
    }
    SetHandleInformation(p->stdin_wr, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(p->stdout_rd, HANDLE_FLAG_INHERIT, 0);

    char cmd[2048];
    snprintf(cmd, sizeof(cmd),
        "wsl.exe -- bash -c \""
        "cd '%s' && LD_LIBRARY_PATH=build/lib "
        "qemu-arm-static -L /usr/arm-linux-gnueabihf "
        "build/ddp_processor build/lib/libdseffect.so 48000 -6 0\"",
        g_wsl_path);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = stdin_rd;
    si.hStdOutput = stdout_wr;
    si.hStdError = INVALID_HANDLE_VALUE;
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(stdin_rd);
        CloseHandle(stdout_wr);
        CloseHandle(p->stdin_wr);
        CloseHandle(p->stdout_rd);
        free(p);
        return NULL;
    }

    CloseHandle(stdin_rd);
    CloseHandle(stdout_wr);
    p->process = pi.hProcess;
    CloseHandle(pi.hThread);

    DWORD magic = 0;
    if (!read_exact(p->stdout_rd, &magic, 4) || magic != READY_MAGIC) {
        TerminateProcess(p->process, 1);
        CloseHandle(p->process);
        CloseHandle(p->stdin_wr);
        CloseHandle(p->stdout_rd);
        free(p);
        return NULL;
    }

    return p;
}

static void processor_stop(Processor *p) {
    if (!p) return;
    DWORD cmd = CMD_SHUTDOWN;
    write_exact(p->stdin_wr, &cmd, 4);
    if (WaitForSingleObject(p->process, 2000) == WAIT_TIMEOUT)
        TerminateProcess(p->process, 1);
    CloseHandle(p->process);
    CloseHandle(p->stdin_wr);
    CloseHandle(p->stdout_rd);
    free(p);
}

/* ── Client Thread ────────────────────────────────────────────────── */

typedef struct {
    HANDLE pipe;
    int    session_id;
} ClientArgs;

static DWORD WINAPI client_thread(LPVOID param) {
    ClientArgs *args = (ClientArgs *)param;
    HANDLE pipe = args->pipe;
    int sid = args->session_id;
    free(args);

    log_msg("Session %d: starting processor...\n", sid);
    Processor *proc = processor_start();
    if (!proc) {
        log_msg("Session %d: processor failed\n", sid);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 1;
    }
    log_msg("Session %d: processor ready\n", sid);

    /* Send ready magic to client */
    DWORD magic = READY_MAGIC;
    if (!write_exact(pipe, &magic, 4)) {
        processor_stop(proc);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 1;
    }

    /* Bridge loop: batch protocol */
    BYTE *buf = (BYTE *)malloc(MAX_FRAMES * 4);
    int blocks = 0;

    for (;;) {
        DWORD total_frames = 0;
        if (!read_exact(pipe, &total_frames, 4)) break;
        if (total_frames == CMD_SHUTDOWN) break;
        if (total_frames > MAX_FRAMES) break;

        DWORD total_bytes = total_frames * 4;
        if (!read_exact(pipe, buf, total_bytes)) break;

        /* Pipeline: write all chunks to processor */
        DWORD off = 0;
        BOOL ok = TRUE;
        while (off < total_frames && ok) {
            DWORD chunk = total_frames - off;
            if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;
            if (!write_exact(proc->stdin_wr, &chunk, 4) ||
                !write_exact(proc->stdin_wr, buf + off * 4, chunk * 4))
                ok = FALSE;
            off += chunk;
        }
        if (!ok) { log_msg("Session %d: proc write err\n", sid); break; }

        /* Read all processed chunks */
        off = 0;
        while (off < total_frames) {
            DWORD chunk = total_frames - off;
            if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;
            if (!read_exact(proc->stdout_rd, buf + off * 4, chunk * 4)) {
                log_msg("Session %d: proc read err\n", sid);
                ok = FALSE;
                break;
            }
            off += chunk;
        }
        if (!ok) break;

        if (!write_exact(pipe, buf, total_bytes)) break;

        blocks++;
        if (blocks <= 3 || blocks % 5000 == 0)
            log_msg("Session %d: block %d (%u frames)\n", sid, blocks, total_frames);
    }

    log_msg("Session %d: done (%d blocks)\n", sid, blocks);
    free(buf);
    processor_stop(proc);
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}

/* ── Main ─────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    InitializeCriticalSection(&g_log_lock);

    printf(
        "DolbyX Bridge v0.8\n"
        "==================\n\n"
    );

    if (argc < 2) {
        printf("Usage: dolbyx-bridge.exe <wsl-path-to-DolbyX/arm>\n");
        printf("Example: dolbyx-bridge.exe /home/avisek/DolbyX/arm\n");
        return 1;
    }
    g_wsl_path = argv[1];

    log_msg("WSL path: %s\n", g_wsl_path);
    log_msg("Pipe: %s\n\n", PIPE_NAME);

    /* Smoke test */
    log_msg("Smoke test...\n");
    Processor *test = processor_start();
    if (!test) {
        log_msg("FATAL: Cannot start processor\n");
        return 1;
    }
    processor_stop(test);
    log_msg("Smoke test passed\n\n");

    log_msg("Listening on %s (Ctrl+C to stop)\n\n", PIPE_NAME);

    /* Permissive security for audiodg.exe */
    SECURITY_DESCRIPTOR sd;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE);
    SECURITY_ATTRIBUTES sa = {sizeof(sa), &sd, FALSE};

    int session = 0;

    for (;;) {
        HANDLE pipe = CreateNamedPipeA(PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            4 * 1024 * 1024, 4 * 1024 * 1024, 0, &sa);

        if (pipe == INVALID_HANDLE_VALUE) {
            log_msg("CreateNamedPipe failed: %lu\n", GetLastError());
            Sleep(1000);
            continue;
        }

        if (!ConnectNamedPipe(pipe, NULL) &&
            GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(pipe);
            continue;
        }

        session++;
        ClientArgs *args = (ClientArgs *)malloc(sizeof(ClientArgs));
        args->pipe = pipe;
        args->session_id = session;

        HANDLE t = CreateThread(NULL, 0, client_thread, args, 0, NULL);
        if (t) {
            CloseHandle(t); /* detach — thread manages its own lifetime */
        } else {
            log_msg("CreateThread failed\n");
            free(args);
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
        }
    }

    DeleteCriticalSection(&g_log_lock);
    return 0;
}
