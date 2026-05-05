/*
 * daemon/http.c — DolbyX HTTP + WebSocket server
 *
 * Minimal embedded HTTP server + RFC 6455 WebSocket.
 * Serves the Web UI and handles real-time control via JSON.
 *
 * JSON protocol:
 *   Client → Server:
 *     {"cmd":"get_state"}
 *     {"cmd":"set_profile","id":1}
 *     {"cmd":"set_param","index":7,"value":1}
 *     {"cmd":"set_ieq","preset":1}
 *     {"cmd":"power","on":true}
 *
 *   Server → Client:
 *     {"type":"state","profile":1,"power":1,"params":[...],"ieq":3}
 *     {"type":"vis","bands":[...]}
 *     {"type":"ack","ok":true}
 */

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "http.h"
#include "ddp_protocol.h"

/* ── Forward declarations from main.c ─────────────────────────────── */

extern void log_msg(const char *fmt, ...);

typedef struct {
    HANDLE process, stdin_wr, stdout_rd;
    CRITICAL_SECTION lock;
} Proc;

extern Proc *g_procs[];
extern CRITICAL_SECTION g_procs_lock;
extern BOOL proc_ctrl(Proc *p, const BYTE *data, int dlen,
                       BYTE *reply, int rlen);

/* ── SHA-1 (minimal, for WebSocket handshake only) ────────────────── */

static void sha1(const uint8_t *msg, size_t len, uint8_t out[20]) {
    uint32_t h0=0x67452301, h1=0xEFCDAB89, h2=0x98BADCFE,
             h3=0x10325476, h4=0xC3D2E1F0;

    /* Pre-processing: pad message */
    size_t ml = len * 8;
    size_t padded = ((len + 8) / 64 + 1) * 64;
    uint8_t *buf = (uint8_t *)calloc(padded, 1);
    memcpy(buf, msg, len);
    buf[len] = 0x80;
    for (int i = 0; i < 8; i++)
        buf[padded - 1 - i] = (uint8_t)(ml >> (i * 8));

    for (size_t chunk = 0; chunk < padded; chunk += 64) {
        uint32_t w[80];
        for (int i = 0; i < 16; i++)
            w[i] = ((uint32_t)buf[chunk+i*4]<<24) |
                   ((uint32_t)buf[chunk+i*4+1]<<16) |
                   ((uint32_t)buf[chunk+i*4+2]<<8) |
                   buf[chunk+i*4+3];
        for (int i = 16; i < 80; i++) {
            uint32_t x = w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16];
            w[i] = (x << 1) | (x >> 31);
        }

        uint32_t a=h0, b=h1, c=h2, d=h3, e=h4;
        for (int i = 0; i < 80; i++) {
            uint32_t f, k;
            if (i < 20)      { f = (b&c)|((~b)&d); k = 0x5A827999; }
            else if (i < 40) { f = b^c^d;           k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b&c)|(b&d)|(c&d); k = 0x8F1BBCDC; }
            else              { f = b^c^d;           k = 0xCA62C1D6; }
            uint32_t tmp = ((a<<5)|(a>>27)) + f + e + k + w[i];
            e=d; d=c; c=(b<<30)|(b>>2); b=a; a=tmp;
        }
        h0+=a; h1+=b; h2+=c; h3+=d; h4+=e;
    }
    free(buf);

    for (int i=0;i<4;i++) { out[i]=(h0>>(24-i*8))&0xFF;
        out[4+i]=(h1>>(24-i*8))&0xFF; out[8+i]=(h2>>(24-i*8))&0xFF;
        out[12+i]=(h3>>(24-i*8))&0xFF; out[16+i]=(h4>>(24-i*8))&0xFF; }
}

/* ── Base64 encode ────────────────────────────────────────────────── */

static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int base64_encode(const uint8_t *in, int len, char *out) {
    int o = 0;
    for (int i = 0; i < len; i += 3) {
        int b = (in[i] << 16) | (i+1<len ? in[i+1]<<8 : 0) | (i+2<len ? in[i+2] : 0);
        out[o++] = b64[(b>>18)&63];
        out[o++] = b64[(b>>12)&63];
        out[o++] = (i+1<len) ? b64[(b>>6)&63] : '=';
        out[o++] = (i+2<len) ? b64[b&63] : '=';
    }
    out[o] = 0;
    return o;
}

/* ── WebSocket client tracking ────────────────────────────────────── */

static SOCKET g_ws_clients[MAX_WS_CLIENTS];
static CRITICAL_SECTION g_ws_lock;
static int g_ws_count = 0;

static void ws_add(SOCKET s) {
    EnterCriticalSection(&g_ws_lock);
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (g_ws_clients[i] == INVALID_SOCKET) {
            g_ws_clients[i] = s;
            g_ws_count++;
            break;
        }
    }
    LeaveCriticalSection(&g_ws_lock);
}

static void ws_remove(SOCKET s) {
    EnterCriticalSection(&g_ws_lock);
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (g_ws_clients[i] == s) {
            g_ws_clients[i] = INVALID_SOCKET;
            g_ws_count--;
            break;
        }
    }
    LeaveCriticalSection(&g_ws_lock);
}

/* ── WebSocket frame I/O ──────────────────────────────────────────── */

static int ws_send_text(SOCKET s, const char *text, int len) {
    /* Build WebSocket text frame (server→client: no mask) */
    uint8_t hdr[10];
    int hlen = 0;

    hdr[0] = 0x81; /* FIN + TEXT opcode */
    if (len < 126) {
        hdr[1] = (uint8_t)len;
        hlen = 2;
    } else if (len < 65536) {
        hdr[1] = 126;
        hdr[2] = (len >> 8) & 0xFF;
        hdr[3] = len & 0xFF;
        hlen = 4;
    } else {
        return -1; /* messages > 64K not supported */
    }

    if (send(s, (char *)hdr, hlen, 0) != hlen) return -1;
    if (send(s, text, len, 0) != len) return -1;
    return 0;
}

/* Read one WebSocket frame. Returns payload length, -1 on error/close. */
static int ws_recv(SOCKET s, char *buf, int bufsize) {
    uint8_t hdr[2];
    if (recv(s, (char *)hdr, 2, 0) != 2) return -1;

    int opcode = hdr[0] & 0x0F;
    int masked = (hdr[1] & 0x80) != 0;
    int plen = hdr[1] & 0x7F;

    if (opcode == 8) return -1; /* close frame */

    if (plen == 126) {
        uint8_t ext[2];
        if (recv(s, (char *)ext, 2, 0) != 2) return -1;
        plen = (ext[0] << 8) | ext[1];
    } else if (plen == 127) {
        return -1; /* 64-bit lengths not supported */
    }

    if (plen > bufsize - 1) return -1;

    uint8_t mask[4] = {0};
    if (masked) {
        if (recv(s, (char *)mask, 4, 0) != 4) return -1;
    }

    int total = 0;
    while (total < plen) {
        int r = recv(s, buf + total, plen - total, 0);
        if (r <= 0) return -1;
        total += r;
    }

    if (masked) {
        for (int i = 0; i < plen; i++)
            buf[i] ^= mask[i % 4];
    }

    buf[plen] = 0;
    return plen;
}

/* ── JSON Parsing (minimal, handles our protocol) ─────────────────── */

static int json_int(const char *json, const char *key) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char *p = strstr(json, needle);
    if (!p) return -999;
    p += strlen(needle);
    while (*p == ' ') p++;
    return atoi(p);
}

static int json_bool(const char *json, const char *key) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char *p = strstr(json, needle);
    if (!p) return -1;
    p += strlen(needle);
    while (*p == ' ') p++;
    if (*p == 't') return 1;
    if (*p == 'f') return 0;
    return atoi(p);
}

static int json_str(const char *json, const char *key, char *out, int outlen) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"%s\":\"", key);
    const char *p = strstr(json, needle);
    if (!p) return -1;
    p += strlen(needle);
    int i = 0;
    while (*p && *p != '"' && i < outlen - 1)
        out[i++] = *p++;
    out[i] = 0;
    return i;
}

/* ── Per-Profile State (daemon-owned) ─────────────────────────────── */

#include "vendor/tomlc17.h"

/* All 6 user profiles, each with independent saved params */
ProfileState g_profile_states[DDP_PROFILE_USER_COUNT];

int g_current_profile = DDP_PROFILE_MUSIC;
int g_current_power = 1;

/* Convenience: current profile's params/ieq */
#define CUR_PARAMS  (g_profile_states[g_current_profile].params)
#define CUR_IEQ     (g_profile_states[g_current_profile].ieq_mode)

#define CONFIG_DIR  "C:\\ProgramData\\DolbyX"
#define CONFIG_PATH CONFIG_DIR "\\config.toml"

static const char *g_profile_names[] = {
    "Movie", "Music", "Game", "Voice", "Custom1", "Custom2"
};

static const char *g_param_names[] = {
    "endp", "vdhe", "dhsb", "dssb", "dssf", "ngon", "dvla",
    "dvle", "dvme", "ieon", "iea",  "deon", "dea",  "ded",
    "plmd", "aoon", "vmb",  "vmon", "geon", "plb"
};

static const char *g_ieq_names[] = { "open", "rich", "focused", "manual" };

/* File watcher state */
static FILETIME g_config_mtime = {0};
static CRITICAL_SECTION g_config_lock;

void save_config(void) {
    EnterCriticalSection(&g_config_lock);
    CreateDirectoryA(CONFIG_DIR, NULL);
    FILE *f = fopen(CONFIG_PATH, "w");
    if (!f) { LeaveCriticalSection(&g_config_lock); return; }

    fprintf(f, "# DolbyX Configuration\n");
    fprintf(f, "# Changes to this file are loaded instantly.\n\n");
    fprintf(f, "active_profile = \"%s\"\n", g_profile_names[g_current_profile]);
    fprintf(f, "power = %s\n", g_current_power ? "true" : "false");

    extern const int16_t g_profiles[][DDP_PARAM_COUNT];
    for (int p = 0; p < DDP_PROFILE_USER_COUNT; p++) {
        fprintf(f, "\n[%s]\n", g_profile_names[p]);
        for (int i = 1; i < DDP_PARAM_COUNT; i++) { /* skip endp (index 0) */
            fprintf(f, "%s = %d\n", g_param_names[i], g_profile_states[p].params[i]);
        }
        fprintf(f, "ieq_mode = \"%s\"\n", g_ieq_names[g_profile_states[p].ieq_mode]);
        fprintf(f, "geq = [");
        for (int i = 0; i < 20; i++)
            fprintf(f, "%s%d", i ? ", " : "", g_profile_states[p].geq[i]);
        fprintf(f, "]\n");
    }

    fclose(f);

    /* Update mtime so the watcher doesn't re-trigger */
    HANDLE hf = CreateFileA(CONFIG_PATH, GENERIC_READ, FILE_SHARE_READ,
                            NULL, OPEN_EXISTING, 0, NULL);
    if (hf != INVALID_HANDLE_VALUE) {
        GetFileTime(hf, NULL, NULL, &g_config_mtime);
        CloseHandle(hf);
    }

    LeaveCriticalSection(&g_config_lock);
}

void load_config(void) {
    EnterCriticalSection(&g_config_lock);

    /* Initialize all profiles from factory defaults */
    extern const int16_t g_profiles[][DDP_PARAM_COUNT];
    for (int p = 0; p < DDP_PROFILE_USER_COUNT; p++) {
        memcpy(g_profile_states[p].params, g_profiles[p],
               sizeof(int16_t) * DDP_PARAM_COUNT);
        g_profile_states[p].ieq_mode = DDP_IEQ_MANUAL;
    }

    toml_result_t r = toml_parse_file_ex(CONFIG_PATH);
    if (!r.ok) {
        log_msg("Config: %s (using defaults)\n",
                r.errmsg[0] ? r.errmsg : "file not found");
        LeaveCriticalSection(&g_config_lock);
        return;
    }

    /* active_profile */
    toml_datum_t d = toml_seek(r.toptab, "active_profile");
    if (d.type == TOML_STRING) {
        for (int i = 0; i < DDP_PROFILE_USER_COUNT; i++) {
            if (strcmp(d.u.s, g_profile_names[i]) == 0) {
                g_current_profile = i;
                break;
            }
        }
    }

    /* power */
    d = toml_seek(r.toptab, "power");
    if (d.type == TOML_BOOLEAN) g_current_power = d.u.boolean ? 1 : 0;

    /* Per-profile sections */
    for (int p = 0; p < DDP_PROFILE_USER_COUNT; p++) {
        toml_datum_t sec = toml_get(r.toptab, g_profile_names[p]);
        if (sec.type != TOML_TABLE) continue;

        for (int i = 1; i < DDP_PARAM_COUNT; i++) {
            toml_datum_t v = toml_get(sec, g_param_names[i]);
            if (v.type == TOML_INT64) {
                g_profile_states[p].params[i] = (int16_t)v.u.int64;
            }
        }

        toml_datum_t ieq = toml_get(sec, "ieq_mode");
        if (ieq.type == TOML_STRING) {
            for (int i = 0; i < 4; i++) {
                if (strcmp(ieq.u.s, g_ieq_names[i]) == 0) {
                    g_profile_states[p].ieq_mode = i;
                    break;
                }
            }
        }

        toml_datum_t geq = toml_get(sec, "geq");
        if (geq.type == TOML_ARRAY) {
            int count = geq.u.arr.size;
            if (count > 20) count = 20;
            for (int i = 0; i < count; i++) {
                if (geq.u.arr.elem[i].type == TOML_INT64)
                    g_profile_states[p].geq[i] = (int16_t)geq.u.arr.elem[i].u.int64;
            }
        }
    }

    toml_free(r);

    /* Record mtime */
    HANDLE hf = CreateFileA(CONFIG_PATH, GENERIC_READ, FILE_SHARE_READ,
                            NULL, OPEN_EXISTING, 0, NULL);
    if (hf != INVALID_HANDLE_VALUE) {
        GetFileTime(hf, NULL, NULL, &g_config_mtime);
        CloseHandle(hf);
    }

    log_msg("Config loaded: profile=%s power=%s\n",
            g_profile_names[g_current_profile],
            g_current_power ? "on" : "off");
    LeaveCriticalSection(&g_config_lock);
}

/* ── Config file watcher (Windows filesystem events) ──────────────── */

static int build_state_json(char *buf, int bufsize); /* forward decl */
static void apply_profile_to_processors(void);       /* forward decl */

static DWORD WINAPI config_watcher_thread(LPVOID param) {
    (void)param;

    /* Watch the config directory for changes */
    HANDLE hNotify = FindFirstChangeNotificationA(
        CONFIG_DIR, FALSE, FILE_NOTIFY_CHANGE_LAST_WRITE);
    if (hNotify == INVALID_HANDLE_VALUE) {
        log_msg("Config watcher: FindFirstChangeNotification failed\n");
        return 1;
    }

    for (;;) {
        DWORD wait = WaitForSingleObject(hNotify, INFINITE);
        if (wait != WAIT_OBJECT_0) break;

        /* Small delay to let the editor finish writing */
        Sleep(100);

        /* Check if mtime actually changed (filter spurious events) */
        HANDLE hf = CreateFileA(CONFIG_PATH, GENERIC_READ, FILE_SHARE_READ,
                                NULL, OPEN_EXISTING, 0, NULL);
        if (hf != INVALID_HANDLE_VALUE) {
            FILETIME ft;
            GetFileTime(hf, NULL, NULL, &ft);
            CloseHandle(hf);
            if (CompareFileTime(&ft, &g_config_mtime) != 0) {
                log_msg("Config file changed -- reloading\n");
                load_config();
                apply_profile_to_processors();
                char resp[1024];
                int rlen = build_state_json(resp, sizeof(resp));
                ws_broadcast(resp, rlen);
            }
        }

        FindNextChangeNotification(hNotify);
    }

    FindCloseChangeNotification(hNotify);
    return 0;
}

static int build_state_json(char *buf, int bufsize) {
    int16_t *P = CUR_PARAMS;
    int ieq = CUR_IEQ;
    int16_t *geq = g_profile_states[g_current_profile].geq;
    int n = snprintf(buf, bufsize,
        "{\"type\":\"state\",\"profile\":%d,\"power\":%d,\"ieq\":%d,\"params\":[",
        g_current_profile, g_current_power, ieq);
    for (int i = 0; i < DDP_PARAM_COUNT; i++)
        n += snprintf(buf + n, bufsize - n, "%s%d", i ? "," : "", P[i]);
    n += snprintf(buf + n, bufsize - n, "],\"geq\":[");
    for (int i = 0; i < 20; i++)
        n += snprintf(buf + n, bufsize - n, "%s%d", i ? "," : "", geq[i]);
    n += snprintf(buf + n, bufsize - n, "]}");
    return n;
}

/* ── Forward command to all processors ────────────────────────────── */

static BOOL forward_cmd(const BYTE *pkt, int pkt_len, BYTE *reply, int reply_len) {
    BOOL any = FALSE;
    EnterCriticalSection(&g_procs_lock);
    for (int i = 0; i < 8; i++) {
        if (!g_procs[i]) continue;
        if (proc_ctrl(g_procs[i], pkt, pkt_len, reply, reply_len))
            any = TRUE;
    }
    LeaveCriticalSection(&g_procs_lock);
    return any;
}

/*
 * Apply the current profile state to all active audio processors.
 * Sends base profile, then per-profile overrides, IEQ preset, and
 * power state. Used by: set_profile, power, reset_profile, config reload.
 */
static void apply_profile_to_processors(void) {
    extern const int16_t g_profiles[][DDP_PARAM_COUNT];
    BYTE pkt[8]; BYTE reply[4]; DWORD c;

    /* If power is off, just send OFF profile */
    if (!g_current_power) {
        c = DDP_CMD_SET_PROFILE;
        DWORD pid = DDP_PROFILE_OFF;
        memcpy(pkt, &c, 4); memcpy(pkt+4, &pid, 4);
        forward_cmd(pkt, 8, reply, 4);
        return;
    }

    /* Send base profile */
    c = DDP_CMD_SET_PROFILE;
    DWORD pid = (DWORD)g_current_profile;
    memcpy(pkt, &c, 4); memcpy(pkt+4, &pid, 4);
    forward_cmd(pkt, 8, reply, 4);

    /* Apply per-profile param overrides */
    int16_t *P = CUR_PARAMS;
    for (int i = 1; i < DDP_PARAM_COUNT; i++) {
        if (P[i] != g_profiles[g_current_profile][i]) {
            c = DDP_CMD_SET_PARAM;
            uint16_t pi = (uint16_t)i; int16_t v = P[i];
            memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
            forward_cmd(pkt, 8, reply, 4);
        }
    }

    /* Apply IEQ preset */
    int ieq = CUR_IEQ;
    if (ieq != DDP_IEQ_MANUAL && ieq >= 0 && ieq <= 2) {
        c = DDP_CMD_SET_PARAM;
        uint16_t pi = DDP_PARAM_IEON; int16_t v = 1;
        memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
        forward_cmd(pkt, 8, reply, 4);
        pi = DDP_PARAM_IEA; v = 10;
        memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
        forward_cmd(pkt, 8, reply, 4);
        c = DDP_CMD_SET_IEQ_PRESET;
        DWORD preset = (DWORD)ieq;
        memcpy(pkt, &c, 4); memcpy(pkt+4, &preset, 4);
        forward_cmd(pkt, 8, reply, 4);
    }

    /* Apply graphic EQ bands (if geon is enabled or any non-zero) */
    int16_t *geq = g_profile_states[g_current_profile].geq;
    int has_geq = 0;
    for (int i = 0; i < 20; i++) if (geq[i] != 0) { has_geq = 1; break; }
    if (has_geq) {
        BYTE geq_pkt[44]; int16_t geq_reply[20];
        c = DDP_CMD_SET_GEQ;
        memcpy(geq_pkt, &c, 4);
        memcpy(geq_pkt + 4, geq, 40);
        forward_cmd(geq_pkt, 44, (BYTE *)geq_reply, 40);
    }
}

/* ── Handle a WebSocket JSON command ──────────────────────────────── */

static void handle_ws_cmd(SOCKET s, const char *json) {
    char cmd[32] = {0};
    json_str(json, "cmd", cmd, sizeof(cmd));

    char resp[1024];
    int rlen;

    if (strcmp(cmd, "get_state") == 0) {
        rlen = build_state_json(resp, sizeof(resp));
        ws_send_text(s, resp, rlen);
        return;
    }

    if (strcmp(cmd, "set_profile") == 0) {
        int id = json_int(json, "id");
        if (id >= 0 && id < DDP_PROFILE_USER_COUNT) {
            g_current_profile = id;
            apply_profile_to_processors();
        }
        rlen = snprintf(resp, sizeof(resp), "{\"type\":\"ack\",\"ok\":true}");
        ws_send_text(s, resp, rlen);
        rlen = build_state_json(resp, sizeof(resp));
        save_config();
        ws_broadcast(resp, rlen);
        return;
    }

    if (strcmp(cmd, "reset_profile") == 0) {
        /* Reset current profile to factory defaults */
        extern const int16_t g_profiles[][DDP_PARAM_COUNT];
        memcpy(CUR_PARAMS, g_profiles[g_current_profile],
               sizeof(int16_t) * DDP_PARAM_COUNT);
        CUR_IEQ = DDP_IEQ_MANUAL;
        apply_profile_to_processors();
        rlen = snprintf(resp, sizeof(resp), "{\"type\":\"ack\",\"ok\":true}");
        ws_send_text(s, resp, rlen);
        rlen = build_state_json(resp, sizeof(resp));
        save_config();
        ws_broadcast(resp, rlen);
        return;
    }

    if (strcmp(cmd, "set_param") == 0) {
        int idx = json_int(json, "index");
        int val = json_int(json, "value");
        if (idx >= 0 && idx < DDP_PARAM_COUNT) {
            BYTE pkt[8];
            DWORD c = DDP_CMD_SET_PARAM;
            uint16_t pi = (uint16_t)idx;
            int16_t v = (int16_t)val;
            memcpy(pkt, &c, 4);
            memcpy(pkt + 4, &pi, 2);
            memcpy(pkt + 6, &v, 2);
            BYTE reply[4] = {0};
            forward_cmd(pkt, 8, reply, 4);
            CUR_PARAMS[idx] = (int16_t)val;
        }
        rlen = snprintf(resp, sizeof(resp), "{\"type\":\"ack\",\"ok\":true}");
        ws_send_text(s, resp, rlen);

        /* Broadcast updated state */
        rlen = build_state_json(resp, sizeof(resp));
        save_config();
        ws_broadcast(resp, rlen);
        return;
    }

    if (strcmp(cmd, "set_ieq") == 0) {
        int preset = json_int(json, "preset");
        if (preset >= 0 && preset <= 3) {
            CUR_IEQ = preset;
            if (preset == DDP_IEQ_MANUAL) {
                /* ieon=0, geon=1 */
                BYTE pkt[8]; DWORD c; BYTE reply[4];
                c = DDP_CMD_SET_PARAM;
                uint16_t pi; int16_t v;

                pi = DDP_PARAM_IEON; v = 0;
                memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
                forward_cmd(pkt, 8, reply, 4);
                CUR_PARAMS[DDP_PARAM_IEON] = 0;

                pi = DDP_PARAM_GEON; v = 1;
                memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
                forward_cmd(pkt, 8, reply, 4);
                CUR_PARAMS[DDP_PARAM_GEON] = 1;
            } else {
                /* geon=0, ieon=1, iea=10, set preset */
                BYTE pkt[8]; DWORD c; BYTE reply[4];
                c = DDP_CMD_SET_PARAM;
                uint16_t pi; int16_t v;

                pi = DDP_PARAM_GEON; v = 0;
                memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
                forward_cmd(pkt, 8, reply, 4);
                CUR_PARAMS[DDP_PARAM_GEON] = 0;

                pi = DDP_PARAM_IEON; v = 1;
                memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
                forward_cmd(pkt, 8, reply, 4);
                CUR_PARAMS[DDP_PARAM_IEON] = 1;

                pi = DDP_PARAM_IEA; v = 10;
                memcpy(pkt, &c, 4); memcpy(pkt+4, &pi, 2); memcpy(pkt+6, &v, 2);
                forward_cmd(pkt, 8, reply, 4);
                CUR_PARAMS[DDP_PARAM_IEA] = 10;

                c = DDP_CMD_SET_IEQ_PRESET;
                DWORD pid = preset;
                memcpy(pkt, &c, 4); memcpy(pkt+4, &pid, 4);
                forward_cmd(pkt, 8, reply, 4);
            }
        }
        rlen = snprintf(resp, sizeof(resp), "{\"type\":\"ack\",\"ok\":true}");
        ws_send_text(s, resp, rlen);
        rlen = build_state_json(resp, sizeof(resp));
        save_config();
        ws_broadcast(resp, rlen);
        return;
    }

    if (strcmp(cmd, "power") == 0) {
        int on = json_bool(json, "on");
        if (on >= 0) {
            g_current_power = on;
            apply_profile_to_processors();
        }
        rlen = snprintf(resp, sizeof(resp), "{\"type\":\"ack\",\"ok\":true}");
        ws_send_text(s, resp, rlen);
        rlen = build_state_json(resp, sizeof(resp));
        save_config();
        ws_broadcast(resp, rlen);
        return;
    }

    if (strcmp(cmd, "set_geq") == 0) {
        /* Parse 20 band values from "bands":[...] */
        const char *arr = strstr(json, "\"bands\":[");
        int16_t gains[20] = {0};
        if (arr) {
            arr += 9; /* skip "bands":[ */
            for (int i = 0; i < 20 && *arr; i++) {
                while (*arr == ' ') arr++;
                int neg = 0, v = 0;
                if (*arr == '-') { neg = 1; arr++; }
                while (*arr >= '0' && *arr <= '9') { v = v*10+(*arr-'0'); arr++; }
                gains[i] = (int16_t)(neg ? -v : v);
                while (*arr == ',' || *arr == ' ') arr++;
            }
        }

        /* Send to processor, get applied values back */
        BYTE pkt[4 + 40];
        DWORD c = DDP_CMD_SET_GEQ;
        memcpy(pkt, &c, 4);
        memcpy(pkt + 4, gains, 40);
        int16_t applied[20] = {0};
        forward_cmd(pkt, 44, (BYTE *)applied, 40);

        /* Store applied values */
        memcpy(g_profile_states[g_current_profile].geq, applied, 40);

        /* Respond with the applied EQ levels */
        int n = snprintf(resp, sizeof(resp), "{\"type\":\"geq\",\"bands\":[");
        for (int i = 0; i < 20; i++)
            n += snprintf(resp+n, sizeof(resp)-n, "%s%d", i?",":"", applied[i]);
        n += snprintf(resp+n, sizeof(resp)-n, "]}");
        ws_send_text(s, resp, n);

        save_config();
        rlen = build_state_json(resp, sizeof(resp));
        ws_broadcast(resp, rlen);
        return;
    }

    /* Unknown command */
    rlen = snprintf(resp, sizeof(resp), "{\"type\":\"ack\",\"ok\":false}");
    ws_send_text(s, resp, rlen);
}

/* ── WebSocket Handshake ──────────────────────────────────────────── */

static int ws_handshake(SOCKET s, const char *request) {
    /* Find Sec-WebSocket-Key */
    const char *key_hdr = strstr(request, "Sec-WebSocket-Key: ");
    if (!key_hdr) return -1;
    key_hdr += 19;
    char key[64] = {0};
    int ki = 0;
    while (*key_hdr && *key_hdr != '\r' && ki < 63)
        key[ki++] = *key_hdr++;

    /* Concatenate with magic GUID */
    char concat[128];
    snprintf(concat, sizeof(concat), "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);

    /* SHA-1 hash */
    uint8_t hash[20];
    sha1((uint8_t *)concat, strlen(concat), hash);

    /* Base64 encode */
    char accept_key[64];
    base64_encode(hash, 20, accept_key);

    /* Send response */
    char response[512];
    int rlen = snprintf(response, sizeof(response),
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: %s\r\n"
        "\r\n", accept_key);

    send(s, response, rlen, 0);
    return 0;
}

/* ── WebSocket Client Thread ──────────────────────────────────────── */

static DWORD WINAPI ws_client_thread(LPVOID param) {
    SOCKET s = (SOCKET)(intptr_t)param;
    log_msg("WebSocket client connected\n");
    ws_add(s);

    /* Send initial state */
    char state[1024];
    int slen = build_state_json(state, sizeof(state));
    ws_send_text(s, state, slen);

    /* Message loop */
    char buf[4096];
    for (;;) {
        int len = ws_recv(s, buf, sizeof(buf));
        if (len <= 0) break;
        handle_ws_cmd(s, buf);
    }

    ws_remove(s);
    closesocket(s);
    log_msg("WebSocket client disconnected\n");
    return 0;
}

/* ── Broadcast to all WebSocket clients ───────────────────────────── */

void ws_broadcast(const char *json, int len) {
    EnterCriticalSection(&g_ws_lock);
    for (int i = 0; i < MAX_WS_CLIENTS; i++) {
        if (g_ws_clients[i] != INVALID_SOCKET) {
            if (ws_send_text(g_ws_clients[i], json, len) != 0) {
                /* Client disconnected — clean up */
                closesocket(g_ws_clients[i]);
                g_ws_clients[i] = INVALID_SOCKET;
                g_ws_count--;
            }
        }
    }
    LeaveCriticalSection(&g_ws_lock);
}

/* ── Embedded HTML Page (generated by ui/build.js) ────────────────── */

#ifdef DOLBYX_USE_BUNDLE
#include "../ui/dist/ui_bundle.h"
#else
/* Fallback: minimal page if bundle not built */
static const unsigned char ui_bundle_html[] = "<html><body><h1>DolbyX</h1>"
    "<p>Run <code>cd ui && node build.js</code> to build the Web UI.</p>"
    "</body></html>";
static const unsigned int ui_bundle_html_len = sizeof(ui_bundle_html) - 1;
#endif

const char *g_html_page = (const char *)ui_bundle_html;
int g_html_page_len = 0;

/* ── HTTP Request Handler ─────────────────────────────────────────── */

static DWORD WINAPI http_client_thread(LPVOID param) {
    SOCKET s = (SOCKET)(intptr_t)param;
    char req[4096] = {0};

    /* Read HTTP request */
    int total = 0;
    while (total < (int)sizeof(req) - 1) {
        int r = recv(s, req + total, sizeof(req) - 1 - total, 0);
        if (r <= 0) { closesocket(s); return 0; }
        total += r;
        if (strstr(req, "\r\n\r\n")) break;
    }

    /* WebSocket upgrade? */
    if (strstr(req, "Upgrade: websocket") || strstr(req, "upgrade: websocket")) {
        if (ws_handshake(s, req) == 0) {
            ws_client_thread((LPVOID)(intptr_t)s);
        } else {
            closesocket(s);
        }
        return 0;
    }

    /* Serve HTML page for GET / */
    if (g_html_page_len == 0)
        g_html_page_len = (int)ui_bundle_html_len;

    char headers[256];
    int hlen = snprintf(headers, sizeof(headers),
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "Content-Length: %d\r\n"
        "Connection: close\r\n"
        "Cache-Control: no-cache\r\n"
        "\r\n", g_html_page_len);

    send(s, headers, hlen, 0);
    send(s, g_html_page, g_html_page_len, 0);
    closesocket(s);
    return 0;
}

/* ── HTTP Server Thread ───────────────────────────────────────────── */

static DWORD WINAPI http_server_thread(LPVOID param) {
    SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv == INVALID_SOCKET) {
        log_msg("HTTP: socket() failed: %d\n", WSAGetLastError());
        return 1;
    }

    int opt = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (char *)&opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(HTTP_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        log_msg("HTTP: bind() failed: %d\n", WSAGetLastError());
        closesocket(srv);
        return 1;
    }

    listen(srv, 8);
    log_msg("Web UI -> http://localhost:%d\n", HTTP_PORT);

    for (;;) {
        SOCKET client = accept(srv, NULL, NULL);
        if (client == INVALID_SOCKET) continue;

        int flag = 1;
        setsockopt(client, IPPROTO_TCP, TCP_NODELAY, (char *)&flag, sizeof(flag));

        HANDLE t = CreateThread(NULL, 0, http_client_thread,
                                (LPVOID)(intptr_t)client, 0, NULL);
        if (t) CloseHandle(t);
        else closesocket(client);
    }

    closesocket(srv);
    return 0;
}

/* ── Visualizer Data Pump (~30fps) ─────────────────────────────────── */

static DWORD WINAPI vis_pump_thread(LPVOID param) {
    (void)param;
    BYTE cmd_pkt[4];
    DWORD vis_cmd = DDP_CMD_GET_VIS;
    memcpy(cmd_pkt, &vis_cmd, 4);

    for (;;) {
        Sleep(33); /* ~30fps */

        if (g_ws_count <= 0) continue; /* no clients, skip */

        /* Poll first active processor */
        int16_t bands[20] = {0};
        EnterCriticalSection(&g_procs_lock);
        for (int i = 0; i < 8; i++) {
            if (!g_procs[i]) continue;
            proc_ctrl(g_procs[i], cmd_pkt, 4, (BYTE *)bands, 40);
            break; /* only poll first active processor */
        }
        LeaveCriticalSection(&g_procs_lock);

        /* Broadcast to all WS clients */
        char json[512];
        int n = snprintf(json, sizeof(json), "{\"type\":\"vis\",\"bands\":[");
        for (int i = 0; i < 20; i++)
            n += snprintf(json+n, sizeof(json)-n, "%s%d", i?",":"", bands[i]);
        n += snprintf(json+n, sizeof(json)-n, "]}");
        ws_broadcast(json, n);
    }
    return 0;
}

/* ── Start ────────────────────────────────────────────────────────── */

void http_start(void) {
    InitializeCriticalSection(&g_ws_lock);
    InitializeCriticalSection(&g_config_lock);
    for (int i = 0; i < MAX_WS_CLIENTS; i++)
        g_ws_clients[i] = INVALID_SOCKET;

    load_config();

    HANDLE t = CreateThread(NULL, 0, http_server_thread, NULL, 0, NULL);
    if (t) CloseHandle(t);

    /* Config file watcher */
    HANDLE tw = CreateThread(NULL, 0, config_watcher_thread, NULL, 0, NULL);
    if (tw) CloseHandle(tw);

    /* Visualizer data pump (~30fps) */
    HANDLE tv = CreateThread(NULL, 0, vis_pump_thread, NULL, 0, NULL);
    if (tv) CloseHandle(tv);
}
