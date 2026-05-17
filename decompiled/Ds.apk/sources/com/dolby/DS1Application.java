package com.dolby;

import android.app.Application;
import android.util.Log;

/* JADX INFO: loaded from: classes.dex */
public class DS1Application extends Application {
    private static DS1Application mContext;

    public static DS1Application getStaticContext() {
        return mContext;
    }

    private static void setStaticContext(DS1Application context) {
        mContext = context;
    }

    @Override // android.app.Application
    public void onCreate() {
        super.onCreate();
        setStaticContext(this);
        int screenLayoutSize = getResources().getConfiguration().screenLayout & 15;
        int densityDpi = getResources().getDisplayMetrics().densityDpi;
        Log.d(Tag.MAIN, "screenLayoutSize: " + screenLayoutSize);
        Log.d(Tag.MAIN, "densityDpi: " + densityDpi);
    }

    @Override // android.app.Application
    public void onTerminate() {
        super.onTerminate();
        setStaticContext(null);
    }
}
