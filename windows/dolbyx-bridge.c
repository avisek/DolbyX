/*
 * dolbyx-bridge.c — DolbyX Named Pipe Bridge (Multi-client + Control)
 *
 * Creates two named pipes:
 *   \\.\pipe\DolbyX     — audio processing (audiodg.exe connects)
 *   \\.\pipe\DolbyXCtrl — control commands (Editor UI connects)
 *
 * Control commands from the UI are forwarded to ALL active audio
 * processor instances, so parameter changes affect the live audio
 * even though the UI runs in a different Windows process.
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
#define CTRL_PIPE_NAME  "\\\\.\\pipe\\DolbyXCtrl"
#define READY_MAGIC     0xDD901DAA
#define CMD_SHUTDOWN    0xFFFFFFFF
#define CHUNK_SIZE      256
#define MAX_FRAMES      131072
#define MAX_SESSIONS    8

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
    CRITICAL_SECTION lock;  /* protects stdin/stdout from concurrent access */
} Processor;

static const char *g_wsl_path = NULL;

/* Global list of active audio processors (for control command routing) */
static Processor *g_audio_procs[MAX_SESSIONS];
static int g_audio_proc_count = 0;
static CRITICAL_SECTION g_proc_lock;

static Processor *processor_start(void) {
    Processor *p = (Processor *)calloc(1, sizeof(Processor));
    InitializeCriticalSection(&p->lock);
    SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
    HANDLE stdin_rd, stdout_wr;

    if (!CreatePipe(&stdin_rd, &p->stdin_wr, &sa, 4 * 1024 * 1024) ||
        !CreatePipe(&p->stdout_rd, &stdout_wr, &sa, 4 * 1024 * 1024)) {
        DeleteCriticalSection(&p->lock);
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
        DeleteCriticalSection(&p->lock);
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
        DeleteCriticalSection(&p->lock);
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
    DeleteCriticalSection(&p->lock);
    free(p);
}

/* Send a control command to a processor (thread-safe) */
static BOOL processor_send_ctrl(Processor *p, const BYTE *data, int len,
                                 BYTE *reply, int reply_len) {
    EnterCriticalSection(&p->lock);
    BOOL ok = write_exact(p->stdin_wr, data, len);
    if (ok && reply && reply_len > 0)
        ok = read_exact(p->stdout_rd, reply, reply_len);
    LeaveCriticalSection(&p->lock);
    return ok;
}

/* ── Named Pipe Security ─────────────────────────────────────────── */

static SECURITY_ATTRIBUTES *get_permissive_sa(void) {
    static SECURITY_DESCRIPTOR sd;
    static SECURITY_ATTRIBUTES sa;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE);
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = &sd;
    sa.bInheritHandle = FALSE;
    return &sa;
}

/* ── Audio Client Thread ──────────────────────────────────────────── */

typedef struct {
    HANDLE pipe;
    int    session_id;
} ClientArgs;

static DWORD WINAPI audio_client_thread(LPVOID param) {
    ClientArgs *args = (ClientArgs *)param;
    HANDLE pipe = args->pipe;
    int sid = args->session_id;
    free(args);

    log_msg("Audio session %d: starting processor...\n", sid);
    Processor *proc = processor_start();
    if (!proc) {
        log_msg("Audio session %d: processor failed\n", sid);
        DisconnectNamedPipe(pipe);
        CloseHandle(pipe);
        return 1;
    }
    log_msg("Audio session %d: processor ready\n", sid);

    /* Register in global list for control command routing */
    EnterCriticalSection(&g_proc_lock);
    int slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (!g_audio_procs[i]) { slot = i; break; }
    }
    if (slot >= 0) {
        g_audio_procs[slot] = proc;
        g_audio_proc_count++;
    }
    LeaveCriticalSection(&g_proc_lock);

    DWORD magic = READY_MAGIC;
    write_exact(pipe, &magic, 4);

    BYTE *buf = (BYTE *)malloc(MAX_FRAMES * 4);
    int blocks = 0;

    for (;;) {
        DWORD frame_count = 0;
        if (!read_exact(pipe, &frame_count, 4)) break;
        if (frame_count == CMD_SHUTDOWN) break;

        /* Control commands from audio pipe (forwarded inline) */
        if (frame_count >= 0xFFFFFFE0) {
            BYTE ctrl_buf[16];
            int extra = 0, reply_len = 4;

            if (frame_count == 0xFFFFFFF0) extra = 4;       /* SET_PARAM */
            else if (frame_count == 0xFFFFFFF1) extra = 4;  /* SET_PROFILE */
            else if (frame_count == 0xFFFFFFF2) reply_len = 40; /* GET_VIS */
            else if (frame_count == 0xFFFFFFEF) extra = 4; /* SET_IEQ_PRESET */
            else if (frame_count == 0xFFFFFFEE) extra = 4; /* SET_GAIN */
            else if (frame_count == 0xFFFFFFFD) reply_len = 4; /* PING */

            if (extra > 0 && !read_exact(pipe, ctrl_buf + 4, extra)) break;
            memcpy(ctrl_buf, &frame_count, 4);

            BYTE reply[40] = {0};
            EnterCriticalSection(&proc->lock);
            write_exact(proc->stdin_wr, ctrl_buf, 4 + extra);
            read_exact(proc->stdout_rd, reply, reply_len);
            LeaveCriticalSection(&proc->lock);

            write_exact(pipe, reply, reply_len);
            continue;
        }

        /* Audio processing */
        if (frame_count > MAX_FRAMES) break;
        DWORD total_bytes = frame_count * 4;
        if (!read_exact(pipe, buf, total_bytes)) break;

        EnterCriticalSection(&proc->lock);

        DWORD off = 0;
        BOOL ok = TRUE;
        while (off < frame_count && ok) {
            DWORD chunk = frame_count - off;
            if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;
            if (!write_exact(proc->stdin_wr, &chunk, 4) ||
                !write_exact(proc->stdin_wr, buf + off * 4, chunk * 4))
                ok = FALSE;
            off += chunk;
        }

        if (ok) {
            off = 0;
            while (off < frame_count) {
                DWORD chunk = frame_count - off;
                if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;
                if (!read_exact(proc->stdout_rd, buf + off * 4, chunk * 4)) {
                    ok = FALSE;
                    break;
                }
                off += chunk;
            }
        }

        LeaveCriticalSection(&proc->lock);

        if (!ok) break;
        if (!write_exact(pipe, buf, total_bytes)) break;

        blocks++;
        if (blocks <= 3 || blocks % 5000 == 0)
            log_msg("Audio session %d: block %d (%u frames)\n",
                    sid, blocks, frame_count);
    }

    /* Unregister from global list */
    EnterCriticalSection(&g_proc_lock);
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (g_audio_procs[i] == proc) {
            g_audio_procs[i] = NULL;
            g_audio_proc_count--;
            break;
        }
    }
    LeaveCriticalSection(&g_proc_lock);

    log_msg("Audio session %d: done (%d blocks)\n", sid, blocks);
    free(buf);
    processor_stop(proc);
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}

/* ── Control Client Thread ────────────────────────────────────────── */

static DWORD WINAPI ctrl_client_thread(LPVOID param) {
    HANDLE pipe = (HANDLE)param;
    log_msg("Control client connected\n");

    /* Send ready magic */
    DWORD magic = READY_MAGIC;
    write_exact(pipe, &magic, 4);

    for (;;) {
        DWORD cmd = 0;
        if (!read_exact(pipe, &cmd, 4)) break;
        if (cmd == CMD_SHUTDOWN) break;

        BYTE ctrl_data[16];
        int data_len = 0, reply_len = 4;
        memcpy(ctrl_data, &cmd, 4);
        data_len = 4;

        if (cmd == 0xFFFFFFF0) {
            /* SET_PARAM: +4 bytes (uint16 idx + int16 val) */
            if (!read_exact(pipe, ctrl_data + 4, 4)) break;
            data_len = 8;
            reply_len = 4;
        } else if (cmd == 0xFFFFFFF1) {
            /* SET_PROFILE: +4 bytes (uint32 profile_id) */
            if (!read_exact(pipe, ctrl_data + 4, 4)) break;
            data_len = 8;
            reply_len = 4;
        } else if (cmd == 0xFFFFFFF2) {
        } else if (cmd == 0xFFFFFFEF) {
        } else if (cmd == 0xFFFFFFEE) {
            /* SET_GAIN: +4 bytes (int16 pre + int16 post) */
            if (!read_exact(pipe, ctrl_data + 4, 4)) break;
            data_len = 8;
            reply_len = 4;
            /* SET_IEQ_PRESET: +4 bytes (uint32 preset_id) */
            if (!read_exact(pipe, ctrl_data + 4, 4)) break;
            data_len = 8;
            reply_len = 4;
            /* GET_VIS: no extra, 40 byte reply */
            reply_len = 40;
        } else if (cmd == 0xFFFFFFFD) {
            /* PING */
            reply_len = 4;
        } else {
            continue;
        }

        /* Forward to ALL active audio processors */
        BYTE reply[40] = {0};
        BOOL any_sent = FALSE;

        EnterCriticalSection(&g_proc_lock);
        for (int i = 0; i < MAX_SESSIONS; i++) {
            Processor *p = g_audio_procs[i];
            if (!p) continue;
            if (processor_send_ctrl(p, ctrl_data, data_len, reply, reply_len))
                any_sent = TRUE;
        }
        LeaveCriticalSection(&g_proc_lock);

        if (!any_sent) {
            /* No audio processors running — return error */
            memset(reply, 0xFF, reply_len);
        }

        write_exact(pipe, reply, reply_len);
    }

    log_msg("Control client disconnected\n");
    DisconnectNamedPipe(pipe);
    CloseHandle(pipe);
    return 0;
}

/* ── Pipe Accept Threads ──────────────────────────────────────────── */

static DWORD WINAPI audio_accept_thread(LPVOID param) {
    SECURITY_ATTRIBUTES *sa = get_permissive_sa();
    int session = 0;

    for (;;) {
        HANDLE pipe = CreateNamedPipeA(PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            4 * 1024 * 1024, 4 * 1024 * 1024, 0, sa);

        if (pipe == INVALID_HANDLE_VALUE) {
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

        HANDLE t = CreateThread(NULL, 0, audio_client_thread, args, 0, NULL);
        if (t) CloseHandle(t);
        else { free(args); DisconnectNamedPipe(pipe); CloseHandle(pipe); }
    }
    return 0;
}

static DWORD WINAPI ctrl_accept_thread(LPVOID param) {
    SECURITY_ATTRIBUTES *sa = get_permissive_sa();

    for (;;) {
        HANDLE pipe = CreateNamedPipeA(CTRL_PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024, 64 * 1024, 0, sa);

        if (pipe == INVALID_HANDLE_VALUE) {
            Sleep(1000);
            continue;
        }

        if (!ConnectNamedPipe(pipe, NULL) &&
            GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(pipe);
            continue;
        }

        HANDLE t = CreateThread(NULL, 0, ctrl_client_thread, pipe, 0, NULL);
        if (t) CloseHandle(t);
        else { DisconnectNamedPipe(pipe); CloseHandle(pipe); }
    }
    return 0;
}

/* ── Main ─────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    InitializeCriticalSection(&g_log_lock);
    InitializeCriticalSection(&g_proc_lock);

    printf("DolbyX Bridge v1.0\n==================\n\n");

    if (argc < 2) {
        printf("Usage: dolbyx-bridge.exe <wsl-path-to-DolbyX/arm>\n");
        return 1;
    }
    g_wsl_path = argv[1];

    log_msg("WSL path: %s\n", g_wsl_path);
    log_msg("Audio pipe: %s\n", PIPE_NAME);
    log_msg("Control pipe: %s\n\n", CTRL_PIPE_NAME);

    /* Smoke test */
    log_msg("Smoke test...\n");
    Processor *test = processor_start();
    if (!test) { log_msg("FATAL: Cannot start processor\n"); return 1; }
    processor_stop(test);
    log_msg("OK!\n\n");

    /* Start accept threads */
    HANDLE audio_thread = CreateThread(NULL, 0, audio_accept_thread, NULL, 0, NULL);
    HANDLE ctrl_thread = CreateThread(NULL, 0, ctrl_accept_thread, NULL, 0, NULL);

    log_msg("Listening (Ctrl+C to stop)\n\n");

    /* Wait forever */
    WaitForSingleObject(audio_thread, INFINITE);
    WaitForSingleObject(ctrl_thread, INFINITE);

    DeleteCriticalSection(&g_log_lock);
    DeleteCriticalSection(&g_proc_lock);
    return 0;
}
