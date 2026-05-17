package com.dolby.ds1appCoreUI;

import android.content.Context;
import android.util.Log;
import com.dolby.ds1appUI.R;

/* JADX INFO: loaded from: classes.dex */
public class Configuration {
    private static final float DEFAULT_MAX_EDIT_GAIN = 12.0f;
    private static final float DEFAULT_MIN_EDIT_GAIN = -12.0f;
    private static Configuration dynamicInstance;
    private float maxEditGain;
    private float minEditGain;

    private Configuration(Context ctx) {
        this.minEditGain = -12.0f;
        this.maxEditGain = DEFAULT_MAX_EDIT_GAIN;
        try {
            this.minEditGain = Float.parseFloat(ctx.getResources().getString(R.string.min_edit_gain));
            this.maxEditGain = Float.parseFloat(ctx.getResources().getString(R.string.max_edit_gain));
        } catch (NullPointerException e) {
            this.minEditGain = Float.NaN;
            this.maxEditGain = Float.NaN;
            Log.e(Tag.MAIN, "Some of values from configuration.xml were not loaded!");
        } catch (NumberFormatException e2) {
            this.minEditGain = Float.NaN;
            this.maxEditGain = Float.NaN;
            Log.e(Tag.MAIN, "Some of values from configuration.xml were not float type!");
        }
    }

    public static Configuration getInstance(Context ctx) {
        if (dynamicInstance == null) {
            dynamicInstance = new Configuration(ctx);
        }
        return dynamicInstance;
    }

    public float getMaxEditGain() {
        return Float.isNaN(this.maxEditGain) ? DEFAULT_MAX_EDIT_GAIN : this.maxEditGain;
    }

    public float getMinEditGain() {
        if (Float.isNaN(this.minEditGain)) {
            return -12.0f;
        }
        return this.minEditGain;
    }
}
