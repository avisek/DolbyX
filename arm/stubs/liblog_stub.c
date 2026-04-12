/*
 * liblog_stub.c — Stub for Android liblog.so
 * Redirects __android_log_print to stderr.
 */
#include <stdio.h>
#include <stdarg.h>
int __android_log_print(int prio, const char* tag, const char* fmt, ...) {
    (void)prio; (void)tag; (void)fmt;
    return 0;
}
