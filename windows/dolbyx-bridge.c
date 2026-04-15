/*
 * dolbyx-bridge.c — DolbyX Named Pipe Bridge
 *
 * Runs as a regular Windows user process. Creates a named pipe that
 * audiodg.exe (EqualizerAPO) can connect to, and bridges audio data
 * to the DDP processor running in WSL2 via QEMU.
 *
 * Architecture:
 *   audiodg.exe ──► \\.\pipe\DolbyX ──► bridge.exe ──► wsl.exe/qemu ──► DDP
 *
 * Build (MinGW from WSL2):
 *   x86_64-w64-mingw32-gcc -O2 -o dolbyx-bridge.exe dolbyx-bridge.c -static
 *
 * Usage (from Windows CMD or PowerShell):
 *   dolbyx-bridge.exe [path_to_DolbyX_arm_in_wsl]
 *
 * Or from WSL2:
 *   cmd.exe /c "$(wslpath -w ../windows/dolbyx-bridge.exe)" /home/user/DolbyX/arm
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIPE_NAME       "\\\\.\\pipe\\DolbyX"
#define CHUNK_BUF       (256 * 2 * 2 + 4)   /* 256 frames * 2ch * 2bytes + header */
#define READY_MAGIC     0xDD901DAA
#define CMD_SHUTDOWN    0xFFFFFFFF

typedef struct {
    HANDLE hProcess;
    HANDLE hChildStdinWrite;
    HANDLE hChildStdoutRead;
} WslProcess;

static void log_msg(const char* fmt, ...) {
    SYSTEMTIME t; GetLocalTime(&t);
    printf("[%02d:%02d:%02d] ", t.wHour, t.wMinute, t.wSecond);
    va_list a; va_start(a, fmt);
    vprintf(fmt, a);
    va_end(a);
    fflush(stdout);
}

/* ── Exact I/O helpers ─────────────────────────────────────────────── */

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

/* ── Start WSL/DDP processor ───────────────────────────────────────── */

static WslProcess* start_ddp(const char* wsl_arm_path) {
    WslProcess* wp = calloc(1, sizeof(WslProcess));
    SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, TRUE };
    HANDLE hStdinRead, hStdoutWrite;

    if (!CreatePipe(&hStdinRead, &wp->hChildStdinWrite, &sa, 1024*1024) ||
        !CreatePipe(&wp->hChildStdoutRead, &hStdoutWrite, &sa, 1024*1024)) {
        log_msg("CreatePipe failed: %lu\n", GetLastError());
        free(wp); return NULL;
    }
    SetHandleInformation(wp->hChildStdinWrite, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(wp->hChildStdoutRead, HANDLE_FLAG_INHERIT, 0);

    char cmdline[2048];
    snprintf(cmdline, sizeof(cmdline),
        "wsl.exe -- bash -c \""
        "cd '%s' && "
        "LD_LIBRARY_PATH=build/lib "
        "qemu-arm-static -L /usr/arm-linux-gnueabihf "
        "build/ddp_processor build/lib/libdseffect.so 48000 -6 0"
        "\"",
        wsl_arm_path);

    STARTUPINFOA si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput  = hStdinRead;
    si.hStdOutput = hStdoutWrite;
    si.hStdError  = GetStdHandle(STD_ERROR_HANDLE);
    ZeroMemory(&pi, sizeof(pi));

    if (!CreateProcessA(NULL, cmdline, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        log_msg("CreateProcess failed: %lu\n", GetLastError());
        CloseHandle(hStdinRead); CloseHandle(hStdoutWrite);
        CloseHandle(wp->hChildStdinWrite); CloseHandle(wp->hChildStdoutRead);
        free(wp); return NULL;
    }
    CloseHandle(hStdinRead);
    CloseHandle(hStdoutWrite);
    wp->hProcess = pi.hProcess;
    CloseHandle(pi.hThread);

    /* Wait for ready magic from processor */
    DWORD magic = 0;
    if (!read_exact(wp->hChildStdoutRead, &magic, 4) || magic != READY_MAGIC) {
        log_msg("Bad magic from processor: 0x%08X\n", magic);
        TerminateProcess(wp->hProcess, 1);
        CloseHandle(wp->hProcess);
        CloseHandle(wp->hChildStdinWrite);
        CloseHandle(wp->hChildStdoutRead);
        free(wp); return NULL;
    }

    return wp;
}

static void stop_ddp(WslProcess* wp) {
    if (!wp) return;
    DWORD cmd = CMD_SHUTDOWN;
    write_exact(wp->hChildStdinWrite, &cmd, 4);
    if (WaitForSingleObject(wp->hProcess, 2000) == WAIT_TIMEOUT)
        TerminateProcess(wp->hProcess, 1);
    CloseHandle(wp->hProcess);
    CloseHandle(wp->hChildStdinWrite);
    CloseHandle(wp->hChildStdoutRead);
    free(wp);
}

/* ── Handle one client on the named pipe ───────────────────────────── */

static DWORD WINAPI handle_client(LPVOID param) {
    HANDLE hPipe = (HANDLE)param;
    static const char* wsl_path = NULL; /* set from main */

    /* Use thread-local storage trick: path is in global */
    extern const char* g_wsl_path;

    log_msg("Client connected, starting DDP processor...\n");

    WslProcess* wp = start_ddp(g_wsl_path);
    if (!wp) {
        log_msg("Failed to start DDP processor\n");
        DisconnectNamedPipe(hPipe);
        CloseHandle(hPipe);
        return 1;
    }
    log_msg("DDP processor ready\n");

    /* Send ready magic to client */
    DWORD magic = READY_MAGIC;
    if (!write_exact(hPipe, &magic, 4)) {
        log_msg("Failed to send magic\n");
        stop_ddp(wp);
        DisconnectNamedPipe(hPipe);
        CloseHandle(hPipe);
        return 1;
    }

    /* Bridge loop: pipe ↔ processor */
    int blocks = 0;
    BYTE buf[256 * 2 * 2]; /* max 256 frames * 2ch * 2 bytes */

    for (;;) {
        /* Read frame count from client */
        DWORD frame_count = 0;
        if (!read_exact(hPipe, &frame_count, 4)) break;

        if (frame_count == CMD_SHUTDOWN) break;
        if (frame_count > 65536) { log_msg("Bad frame count: %u\n", frame_count); break; }

        DWORD pcm_bytes = frame_count * 2 * 2;

        /* Read PCM from client */
        BYTE* pcm = (pcm_bytes <= sizeof(buf)) ? buf : (BYTE*)malloc(pcm_bytes);
        if (!read_exact(hPipe, pcm, pcm_bytes)) {
            if (pcm != buf) free(pcm);
            break;
        }

        /* Forward to processor: frame_count + pcm */
        if (!write_exact(wp->hChildStdinWrite, &frame_count, 4) ||
            !write_exact(wp->hChildStdinWrite, pcm, pcm_bytes)) {
            log_msg("Write to processor failed\n");
            if (pcm != buf) free(pcm);
            break;
        }

        /* Read processed PCM from processor */
        if (!read_exact(wp->hChildStdoutRead, pcm, pcm_bytes)) {
            log_msg("Read from processor failed\n");
            if (pcm != buf) free(pcm);
            break;
        }

        /* Send to client */
        if (!write_exact(hPipe, pcm, pcm_bytes)) {
            if (pcm != buf) free(pcm);
            break;
        }

        if (pcm != buf) free(pcm);
        blocks++;
    }

    log_msg("Client disconnected after %d blocks\n", blocks);
    stop_ddp(wp);
    DisconnectNamedPipe(hPipe);
    CloseHandle(hPipe);
    return 0;
}

/* ── Global path (accessed from threads) ──────────────────────────── */
const char* g_wsl_path = NULL;

/* ── Main ──────────────────────────────────────────────────────────── */

int main(int argc, char* argv[]) {
    printf("╔══════════════════════════════════════════╗\n");
    printf("║   DolbyX Bridge — Named Pipe Server      ║\n");
    printf("╚══════════════════════════════════════════╝\n\n");

    /* Determine WSL path to DolbyX/arm */
    if (argc >= 2) {
        g_wsl_path = argv[1];
    } else {
        /* Try to auto-detect from registry or default */
        g_wsl_path = "/home/user/DolbyX/arm";
        printf("Usage: dolbyx-bridge.exe <wsl-path-to-DolbyX-arm>\n");
        printf("Example: dolbyx-bridge.exe /home/avisek/DolbyX/arm\n\n");
        printf("Using default: %s\n", g_wsl_path);
    }

    log_msg("WSL path: %s\n", g_wsl_path);
    log_msg("Named pipe: %s\n", PIPE_NAME);

    /* Smoke test: verify processor can start */
    log_msg("Smoke test...\n");
    WslProcess* test = start_ddp(g_wsl_path);
    if (!test) {
        log_msg("FAILED: Cannot start DDP processor. Check WSL2 and build.\n");
        return 1;
    }
    stop_ddp(test);
    log_msg("Smoke test passed!\n\n");

    log_msg("Waiting for VST connections on %s\n", PIPE_NAME);
    log_msg("Press Ctrl+C to stop\n\n");

    /* Create a security descriptor that allows ALL local processes
     * to connect, including audiodg.exe (runs as LOCAL SERVICE).
     * A NULL DACL = unrestricted access for any local account. */
    SECURITY_DESCRIPTOR sd;
    InitializeSecurityDescriptor(&sd, SECURITY_DESCRIPTOR_REVISION);
    SetSecurityDescriptorDacl(&sd, TRUE, NULL /* NULL DACL = allow all */, FALSE);
    SECURITY_ATTRIBUTES pipe_sa = { sizeof(pipe_sa), &sd, FALSE };

    /* Main loop: create named pipe instances and accept connections */
    for (;;) {
        HANDLE hPipe = CreateNamedPipeA(
            PIPE_NAME,
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            1024 * 1024,
            1024 * 1024,
            0,
            &pipe_sa      /* permissive security — lets audiodg.exe connect */
        );

        if (hPipe == INVALID_HANDLE_VALUE) {
            log_msg("CreateNamedPipe failed: %lu\n", GetLastError());
            Sleep(1000);
            continue;
        }

        /* Wait for client connection (blocking) */
        if (!ConnectNamedPipe(hPipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
            log_msg("ConnectNamedPipe failed: %lu\n", GetLastError());
            CloseHandle(hPipe);
            continue;
        }

        /* Handle client in a new thread */
        HANDLE hThread = CreateThread(NULL, 0, handle_client, hPipe, 0, NULL);
        if (hThread) CloseHandle(hThread);
    }

    return 0;
}
