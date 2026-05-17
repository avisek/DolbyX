package com.dolby.ds1appCoreUI;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Resources;
import android.graphics.Point;
import android.os.Handler;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.util.Log;

/* JADX INFO: loaded from: classes.dex */
public class DS1Application extends Application {
    public static final int CUSTOM_1_NAME_MODIFIED = 1;
    public static final int CUSTOM_2_NAME_MODIFIED = 2;
    public static final int CUSTOM_NAME_NOT_MODIFIED = 0;
    private static final String DS_DEFAULT_NAME_CUSTOM1 = "Custom 1";
    private static final String DS_DEFAULT_NAME_CUSTOM2 = "Custom 2";
    private static final String PREFS_NAME = "DsUICustomProfile";
    public static final boolean VISUALIZER_ENABLE = true;
    public static final String TAG = DS1Application.class.getSimpleName();
    public static final Handler HANDLER = new Handler(Looper.getMainLooper());

    public static String getDefaultProfileNameCustom1() {
        return DS_DEFAULT_NAME_CUSTOM1;
    }

    public static String getDefaultProfileNameCustom2() {
        return DS_DEFAULT_NAME_CUSTOM2;
    }

    public static int getCustomModifyFlag(Context context) {
        boolean bModified_Custom1 = false;
        boolean bModified_Custom2 = false;
        if (context != null) {
            SharedPreferences sp = context.getSharedPreferences(PREFS_NAME, 5);
            bModified_Custom1 = sp.getBoolean("bModified_Custom1", false);
            bModified_Custom2 = sp.getBoolean("bModified_Custom2", false);
        } else {
            Log.e(TAG, "getCustomModifyFlag(), context == null");
        }
        int ret = 0;
        if (true == bModified_Custom1) {
            ret = 0 | 1;
        }
        if (true == bModified_Custom2) {
            return ret | 2;
        }
        return ret;
    }

    public static void saveCustomNameModifiedStatus(Context context, boolean bModified_Custom1, boolean bModified_Custom2) {
        SharedPreferences sp = context.getSharedPreferences(PREFS_NAME, 5);
        SharedPreferences.Editor editor = sp.edit();
        editor.putBoolean("bModified_Custom1", bModified_Custom1);
        editor.putBoolean("bModified_Custom2", bModified_Custom2);
        editor.commit();
    }

    public void printScreenSpecs() {
        int screenLayoutSize = getResources().getConfiguration().screenLayout & 15;
        int densityDpi = getResources().getDisplayMetrics().densityDpi;
        Log.d(Tag.MAIN, "screenLayoutSize: " + screenLayoutSize);
        Log.d(Tag.MAIN, "densityDpi: " + densityDpi);
    }

    public Point getScreenResolution() {
        Point p = new Point();
        DisplayMetrics dm = getResources().getDisplayMetrics();
        int screenW = dm.widthPixels;
        int screenH = dm.heightPixels + Constants.STATUS_BAR_HEIGHT;
        if (screenH > screenW) {
            screenH = screenW;
            screenW = screenH;
        }
        p.x = screenW;
        p.y = screenH;
        return p;
    }

    public void checkAndReplaceScreenSize(int screenW, int screenH) {
        Resources res = getResources();
        DisplayMetrics dm = res.getDisplayMetrics();
        android.content.res.Configuration conf = res.getConfiguration();
        int screenLayout = conf.screenLayout;
        int nativeScreenSize = screenLayout & 15;
        if (3 == nativeScreenSize || 4 == nativeScreenSize) {
            if (screenW <= 0 || screenH <= 0) {
                Point screenRes = getScreenResolution();
                screenW = screenRes.x;
                screenH = screenRes.y;
            } else if (screenH > screenW) {
                screenW = screenH;
                screenH = screenW;
            }
            if (screenW >= 1280 && screenH >= 800) {
                screenLayout = (screenLayout - nativeScreenSize) | 4;
            } else if (screenW >= 1024 && screenH >= 600) {
                screenLayout = (screenLayout - nativeScreenSize) | 3;
            }
            if (screenW >= 1920 || screenH >= 1920) {
                dm.densityDpi = 240;
            } else {
                dm.densityDpi = 160;
            }
            dm.density = dm.densityDpi / 160.0f;
            dm.scaledDensity = dm.densityDpi / 160.0f;
        }
        conf.screenLayout = screenLayout;
        res.updateConfiguration(conf, dm);
    }
}
