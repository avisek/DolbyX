package com.dolby.ds1appCoreUI;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.os.Process;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import java.text.DecimalFormat;

/* JADX INFO: loaded from: classes.dex */
public class Tools {
    public static final DecimalFormat mDecFormat = new DecimalFormat("@@##");

    public static final int lcm(int x1, int x2) {
        int max;
        int min;
        if (x1 <= 0 || x2 <= 0) {
            throw new IllegalArgumentException("Cannot compute the least common multiple of two numbers if one, at least,is negative.");
        }
        if (x1 > x2) {
            max = x1;
            min = x2;
        } else {
            max = x2;
            min = x1;
        }
        for (int i = 1; i <= min; i++) {
            if ((max * i) % min == 0) {
                return i * max;
            }
        }
        throw new Error("Cannot find the least common multiple of numbers " + x1 + " and " + x2);
    }

    public static void killMyself(Context context) {
        ActivityManager am = (ActivityManager) context.getSystemService("activity");
        try {
            am.restartPackage(context.getPackageName());
            Thread.sleep(500L);
        } catch (Throwable th) {
        }
        try {
            Process.killProcess(Process.myPid());
            Thread.sleep(500L);
        } catch (Throwable th2) {
        }
    }

    public static void showVirtualKeyboard(Context context) {
        InputMethodManager imm = (InputMethodManager) context.getSystemService("input_method");
        imm.toggleSoftInput(0, 0);
    }

    public static void showVirtualKeyboard(View v) {
        InputMethodManager imm = (InputMethodManager) v.getContext().getSystemService("input_method");
        imm.showSoftInput(v, 0);
    }

    public static boolean hideVirtualKeyboard(Activity currentActivity) {
        View currentView = currentActivity.getCurrentFocus();
        if (currentView == null) {
            return false;
        }
        InputMethodManager imm = (InputMethodManager) currentActivity.getSystemService("input_method");
        boolean keyboardHidden = imm.hideSoftInputFromWindow(currentView.getWindowToken(), 0);
        return keyboardHidden;
    }

    public static boolean isLandscapeScreenOrientation(Context context) {
        return 2 == context.getResources().getConfiguration().orientation;
    }

    public static String floatArrayToString(float[] arr) {
        StringBuffer sb = new StringBuffer();
        for (float f : arr) {
            if (sb.length() != 0) {
                sb.append(", ");
            }
            sb.append(mDecFormat.format(f));
        }
        return sb.toString();
    }
}
