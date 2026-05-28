/*
 * liblog_stub.c — Noisy Android liblog stub for the ddp_probe harness.
 *
 * Forwards `__android_log_print` and friends to stderr so the engine's
 * own log messages (settingsCache updates, ak_set forwards, graceful
 * enable/disable announcements) are visible to the operator.  This is
 * the difference between "the engine works" (silent) and "we know
 * exactly what the engine did" (verbose).
 *
 * Drop-in replacement for arm/stubs/liblog_stub.c.  Used only by the
 * probe harness; the production v1 build keeps its silent stub.
 */
#include <stdio.h>
#include <stdarg.h>

int __android_log_print(int prio, const char *tag, const char *fmt, ...) {
    (void)prio;
    fprintf(stderr, "[%s] ", tag ? tag : "?");
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
    return 0;
}

int __android_log_vprint(int prio, const char *tag, const char *fmt,
                         va_list ap) {
    (void)prio;
    fprintf(stderr, "[%s] ", tag ? tag : "?");
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    fflush(stderr);
    return 0;
}

int __android_log_write(int prio, const char *tag, const char *text) {
    (void)prio;
    fprintf(stderr, "[%s] %s\n", tag ? tag : "?", text ? text : "(null)");
    fflush(stderr);
    return 0;
}

void __android_log_assert(const char *cond, const char *tag,
                          const char *fmt, ...) {
    fprintf(stderr, "[%s] ASSERT(%s): ", tag ? tag : "?",
            cond ? cond : "?");
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
    fflush(stderr);
}
