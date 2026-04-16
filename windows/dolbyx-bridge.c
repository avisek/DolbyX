/*
 * dolbyx-bridge.c — DolbyX Named Pipe Bridge (Optimized)
 *
 * Creates \\.\pipe\DolbyX with permissive ACL for audiodg.exe.
 * Pre-warms DDP processor on startup. Uses batch+pipeline protocol
 * to minimize IPC overhead.
 *
 * Build: x86_64-w64-mingw32-gcc -O2 -o dolbyx-bridge.exe dolbyx-bridge.c -static -ladvapi32
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIPE_NAME       "\\\\.\\pipe\\DolbyX"
#define READY_MAGIC     0xDD901DAA
#define CMD_SHUTDOWN    0xFFFFFFFF
#define CHUNK_SIZE      256
#define MAX_FRAMES      131072  /* 2.7s at 48kHz */

static void log_msg(const char* fmt, ...) {
    SYSTEMTIME t; GetLocalTime(&t);
    printf("[%02d:%02d:%02d.%03d] ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a; va_start(a, fmt); vprintf(fmt, a); va_end(a);
    fflush(stdout);
}

static BOOL read_exact(HANDLE h, void* buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD r = 0;
        if (!ReadFile(h, (BYTE*)buf + total, n - total, &r, NULL) || r == 0)
            return FALSE;
        total += r;
    }
    return TRUE;
}

static BOOL write_exact(HANDLE h, const void* buf, DWORD n) {
    DWORD total = 0;
    while (total < n) {
        DWORD w = 0;
        if (!WriteFile(h, (const BYTE*)buf + total, n - total, &w, NULL) || w == 0)
            return FALSE;
        total += w;
    }
    return TRUE;
}

/* ── Processor management ──────────────────────────────────────────── */

typedef struct {
    HANDLE hProcess;
    HANDLE hStdinWrite;
    HANDLE hStdoutRead;
} Processor;

static Processor* start_processor(const char* wsl_path) {
    Processor* p = calloc(1, sizeof(Processor));
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE hStdinRead, hStdoutWrite;

    if (!CreatePipe(&hStdinRead, &p->hStdinWrite, &sa, 4*1024*1024) ||
        !CreatePipe(&p->hStdoutRead, &hStdoutWrite, &sa, 4*1024*1024)) {
        free(p); return NULL;
    }
    SetHandleInformation(p->hStdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(p->hStdoutRead, HANDLE_FLAG_INHERIT, 0);

    char cmd[2048];
    snprintf(cmd, sizeof(cmd),
        "wsl.exe -- bash -c \""
        "cd '%s' && LD_LIBRARY_PATH=build/lib "
        "qemu-arm-static -L /usr/arm-linux-gnueabihf "
        "build/ddp_processor build/lib/libdseffect.so 48000 -6 0\"",
        wsl_path);

    STARTUPINFOA si; PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = hStdinRead; si.hStdOutput = hStdoutWrite;
    si.hStdError = INVALID_HANDLE_VALUE;
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        log_msg("CreateProcess failed: %lu\n", GetLastError());
        CloseHandle(hStdinRead); CloseHandle(hStdoutWrite);
        CloseHandle(p->hStdinWrite); CloseHandle(p->hStdoutRead);
        free(p); return NULL;
    }
    CloseHandle(hStdinRead); CloseHandle(hStdoutWrite);
    p->hProcess = pi.hProcess; CloseHandle(pi.hThread);

    DWORD magic = 0;
    if (!read_exact(p->hStdoutRead, &magic, 4) || magic != READY_MAGIC) {
        log_msg("Bad magic: 0x%08X\n", magic);
        TerminateProcess(p->hProcess, 1);
        CloseHandle(p->hProcess); CloseHandle(p->hStdinWrite);
        CloseHandle(p->hStdoutRead); free(p); return NULL;
    }
    return p;
}

static void stop_processor(Processor* p) {
    if (!p) return;
    DWORD cmd = CMD_SHUTDOWN;
    write_exact(p->hStdinWrite, &cmd, 4);
    if (WaitForSingleObject(p->hProcess, 2000) == WAIT_TIMEOUT)
        TerminateProcess(p->hProcess, 1);
    CloseHandle(p->hProcess);
    CloseHandle(p->hStdinWrite);
    CloseHandle(p->hStdoutRead);
    free(p);
}

/* ── Client handler (batch + pipeline protocol) ───────────────────── */

/*
 * Protocol (batch mode):
 *   Bridge → Client:  uint32_t READY_MAGIC
 *   Client → Bridge:  uint32_t total_frames + int16_t pcm[frames*2]
 *   Bridge internally: chunks into 256-frame pieces, pipelines to processor
 *   Bridge → Client:  int16_t pcm[frames*2]  (processed)
 *   Client → Bridge:  total_frames=0xFFFFFFFF → disconnect
 *
 * The bridge writes ALL chunks to the processor's stdin before reading
 * ANY results. The OS pipe buffers (4MB) hold the data. The processor
 * processes sequentially and its stdout fills up. Then the bridge reads
 * all results. This "pipeline" approach eliminates per-chunk round trips.
 */

const char* g_wsl_path = NULL;

static DWORD WINAPI handle_client(LPVOID param) {
    HANDLE hPipe = (HANDLE)param;

    log_msg("Client connected, starting processor...\n");
    Processor* proc = start_processor(g_wsl_path);
    if (!proc) {
        log_msg("Processor start failed\n");
        DWORD magic = 0; write_exact(hPipe, &magic, 4); /* signal failure */
        DisconnectNamedPipe(hPipe); CloseHandle(hPipe); return 1;
    }
    log_msg("Processor ready\n");

    DWORD magic = READY_MAGIC;
    write_exact(hPipe, &magic, 4);

    BYTE* pcm_buf = (BYTE*)malloc(MAX_FRAMES * 2 * 2);
    int blocks = 0;

    for (;;) {
        DWORD total_frames = 0;
        if (!read_exact(hPipe, &total_frames, 4)) break;
        if (total_frames == CMD_SHUTDOWN) break;
        if (total_frames > MAX_FRAMES) {
            log_msg("Frames too large: %u\n", total_frames);
            break;
        }

        DWORD total_bytes = total_frames * 2 * 2;
        if (!read_exact(hPipe, pcm_buf, total_bytes)) break;

        /* ── Pipeline: write ALL chunks to processor stdin ────── */
        DWORD offset = 0;
        while (offset < total_frames) {
            DWORD chunk = total_frames - offset;
            if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;
            DWORD chunk_bytes = chunk * 2 * 2;

            if (!write_exact(proc->hStdinWrite, &chunk, 4) ||
                !write_exact(proc->hStdinWrite, pcm_buf + offset * 2 * 2, chunk_bytes)) {
                log_msg("Processor write failed\n");
                goto done;
            }
            offset += chunk;
        }

        /* ── Read ALL processed chunks from processor stdout ──── */
        offset = 0;
        while (offset < total_frames) {
            DWORD chunk = total_frames - offset;
            if (chunk > CHUNK_SIZE) chunk = CHUNK_SIZE;
            DWORD chunk_bytes = chunk * 2 * 2;

            if (!read_exact(proc->hStdoutRead, pcm_buf + offset * 2 * 2, chunk_bytes)) {
                log_msg("Processor read failed\n");
                goto done;
            }
            offset += chunk;
        }

        /* ── Send entire processed block back to client ──────── */
        if (!write_exact(hPipe, pcm_buf, total_bytes)) break;

        blocks++;
        if (blocks <= 3 || blocks % 5000 == 0)
            log_msg("Block %d: %u frames\n", blocks, total_frames);
    }

done:
    log_msg("Client disconnected after %d blocks\n", blocks);
    free(pcm_buf);
    stop_processor(proc);
    DisconnectNamedPipe(hPipe); CloseHandle(hPipe);
    return 0;
}

/* ── Main ──────────────────────────────────────────────────────────── */

int main(int argc, char* argv[]) {
    printf("DolbyX Bridge v0.6\n\n");

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
    Processor* test = start_processor(g_wsl_path);
    if (!test) { log_msg("FAILED\n"); return 1; }
    stop_processor(test);
    log_msg("OK!\n\n");

    log_msg("Listening on %s (Ctrl+C to stop)\n\n", PIPE_NAME);

    /* Permissive security for audiodg.exe */
    SECURITY_DESCRIPTOR sd;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL, FALSE);
    SECURITY_ATTRIBUTES pipe_sa = { sizeof(pipe_sa), &sd, FALSE };

    for (;;) {
        HANDLE hPipe = CreateNamedPipeA(PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES, 4*1024*1024, 4*1024*1024, 0, &pipe_sa);

        if (hPipe == INVALID_HANDLE_VALUE) {
            log_msg("CreateNamedPipe failed: %lu\n", GetLastError());
            Sleep(1000); continue;
        }

        if (!ConnectNamedPipe(hPipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
            CloseHandle(hPipe); continue;
        }

        HANDLE t = CreateThread(NULL, 0, handle_client, hPipe, 0, NULL);
        if (t) CloseHandle(t);
    }
    return 0;
}
