/*
 * daemon/http.h — DolbyX HTTP + WebSocket server
 */
#ifndef DOLBYX_HTTP_H
#define DOLBYX_HTTP_H

#include <winsock2.h>
#include <windows.h>
#include <stdint.h>
#include "ddp_protocol.h"

#define HTTP_PORT 9876
#define MAX_WS_CLIENTS 8

/* Start the HTTP/WS server (loads config, starts listener thread) */
void http_start(void);

/* Broadcast JSON text to all connected WebSocket clients */
void ws_broadcast(const char *json, int len);

/* Config persistence */
void save_config(void);
void load_config(void);

/* Daemon-owned state (persisted to config.toml) */
extern int g_current_profile;
extern int g_current_power;
extern int16_t g_current_params[];
extern int g_current_ieq;

#endif
