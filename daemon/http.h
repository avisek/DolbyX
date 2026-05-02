/*
 * daemon/http.h — DolbyX HTTP + WebSocket server
 *
 * Serves the Web UI on localhost:9876 and handles bidirectional
 * WebSocket communication for real-time control + visualizer data.
 */
#ifndef DOLBYX_HTTP_H
#define DOLBYX_HTTP_H

#include <winsock2.h>
#include <windows.h>
#include <stdint.h>

#define HTTP_PORT 9876
#define MAX_WS_CLIENTS 8

/* Start the HTTP/WS server thread. Returns immediately. */
void http_start(void);

/* Broadcast a text message to all connected WebSocket clients. */
void ws_broadcast(const char *json, int len);

/* The embedded HTML page (generated from ui/dist/ui_bundle.h or inline) */
extern const char *g_html_page;
extern int g_html_page_len;

#endif /* DOLBYX_HTTP_H */
