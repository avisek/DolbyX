package com.dolby.ds1appUI;

import java.util.ArrayList;

/* JADX INFO: loaded from: classes.dex */
public class FPSCounter {
    private double mFps;
    private final ArrayList<Long> mTimestamps = new ArrayList<>();

    public void nextFrame() {
        nextFrame(System.currentTimeMillis());
    }

    public void nextFrame(long now) {
        this.mTimestamps.add(Long.valueOf(now));
        while (this.mTimestamps.size() > 2 && this.mTimestamps.get(0).longValue() < now - 1000) {
            this.mTimestamps.remove(0);
        }
        double fps = this.mTimestamps.get(this.mTimestamps.size() - 1).longValue() - this.mTimestamps.get(0).longValue();
        this.mFps = 1000.0d / (fps / ((double) (this.mTimestamps.size() - 1)));
    }

    public double getFPS() {
        return this.mFps;
    }
}
