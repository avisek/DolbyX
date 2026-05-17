package com.dolby.ds1appUI;

import android.view.MotionEvent;
import android.view.View;
import android.widget.ToggleButton;

/* JADX INFO: loaded from: classes.dex */
public class ToggleSlideListener implements View.OnTouchListener {
    private boolean mDetected;
    private float mHalfWidth;
    private float mMinDist;
    private boolean mRight;
    private float mStartX;

    @Override // android.view.View.OnTouchListener
    public boolean onTouch(View v, MotionEvent e) {
        int action = e.getAction();
        if (action == 0) {
            this.mDetected = false;
            this.mStartX = e.getX();
            this.mHalfWidth = v.getWidth() / 2;
            this.mMinDist = v.getWidth() / 4;
            if (v instanceof ToggleButton) {
                this.mRight = !((ToggleButton) v).isChecked();
            }
            if (testXonOtherHalf(this.mStartX)) {
                onDetected(v);
            }
            return this.mDetected;
        }
        if (this.mDetected) {
            return true;
        }
        if (2 == action) {
            float x = e.getX();
            if (this.mRight) {
                if (x >= 0.0f && x < this.mStartX) {
                    this.mStartX = x;
                }
            } else if (x > this.mStartX && x < v.getWidth()) {
                this.mStartX = x;
            }
            if (testXonOtherHalf(x)) {
                onDetected(v);
            } else {
                if (this.mRight == (x > this.mStartX) && Math.abs(x - this.mStartX) >= this.mMinDist) {
                    onDetected(v);
                }
            }
        }
        return this.mDetected;
    }

    private void onDetected(View v) {
        this.mDetected = true;
        v.performClick();
    }

    private boolean testXonOtherHalf(float x) {
        return this.mRight == ((x > this.mHalfWidth ? 1 : (x == this.mHalfWidth ? 0 : -1)) > 0);
    }
}
