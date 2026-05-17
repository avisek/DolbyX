package com.dolby.ds1appUI;

import android.content.Context;
import android.graphics.Typeface;

/* JADX INFO: loaded from: classes.dex */
public class Assets {
    private static Typeface sFontLight;
    private static Typeface sFontMedium;
    private static Typeface sFontRegular;

    public enum FontType {
        REGULAR,
        LIGHT,
        MEDIUM
    }

    public static void init(Context context) {
        sFontRegular = Typeface.createFromAsset(context.getAssets(), "fonts/Roboto-Regular.ttf");
        sFontLight = Typeface.createFromAsset(context.getAssets(), "fonts/Roboto-Light.ttf");
        sFontMedium = Typeface.createFromAsset(context.getAssets(), "fonts/Roboto-Medium.ttf");
    }

    public static final Typeface getFont(FontType type) {
        switch (type) {
            case LIGHT:
                return sFontLight;
            case MEDIUM:
                return sFontMedium;
            default:
                return sFontRegular;
        }
    }
}
