package android.dolby;

import android.util.Log;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public class DsLog {
    public static final int DEFAULT_LOG_LEVEL = 1;
    public static final int LOG_LEVEL_0 = 0;
    public static final int LOG_LEVEL_1 = 1;
    public static final int LOG_LEVEL_2 = 2;
    public static final int LOG_LEVEL_3 = 3;

    public static void log1(String tag, String content) {
        Log.i(tag, content);
    }

    public static void log2(String tag, String content) {
    }

    public static void log3(String tag, String content) {
    }
}
