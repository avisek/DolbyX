package com.dolby.ds1appUI;

import android.content.Context;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.drawable.BitmapDrawable;
import com.dolby.instoredemoapp.ConstValue;

/* JADX INFO: loaded from: classes.dex */
public class GraphicVisualiserPainter {
    public static final int ROWS = 48;
    public static final int ROWS_RED = 12;
    public static final int ROWS_YELLOW = 6;
    private final BitmapDrawable mBarBlue;
    private final BitmapDrawable mBarBlueLight;
    private final BitmapDrawable mBarEmpty;
    private final BitmapDrawable mBarRed;
    private final BitmapDrawable mBarYellow;
    private final BitmapDrawable mBg;
    private final Context mContext;
    private final float[] mGains;
    private final float[] mGainsUser;
    private int mHeight;
    private Bitmap mScaledBarBlue;
    private Bitmap mScaledBarBlueLight;
    private Bitmap mScaledBarEmpty;
    private Bitmap mScaledBarRed;
    private Bitmap mScaledBarYellow;
    private Bitmap mScaledBg;
    private final GraphicVisualiser mVisualizer;
    private int mWidth;
    private final float[] mExcitations = new float[20];
    private boolean mEnabled = true;
    private final Object barLock = new Object();

    public GraphicVisualiserPainter(Context context, GraphicVisualiser visualizer, float[] gainsUi, float[] gainsUser) {
        this.mContext = context;
        this.mVisualizer = visualizer;
        this.mGains = gainsUi;
        this.mGainsUser = gainsUser;
        Resources res = this.mContext.getResources();
        this.mBg = (BitmapDrawable) res.getDrawable(R.drawable.eq_background);
        this.mBarEmpty = (BitmapDrawable) res.getDrawable(R.drawable.mock_gv_brick);
        this.mBarBlue = (BitmapDrawable) res.getDrawable(R.drawable.mock_gv_brick_blue);
        this.mBarYellow = (BitmapDrawable) res.getDrawable(R.drawable.mock_gv_brick_yellow);
        this.mBarRed = (BitmapDrawable) res.getDrawable(R.drawable.mock_gv_brick_red);
        this.mBarBlueLight = (BitmapDrawable) res.getDrawable(R.drawable.mock_gv_brick_blue_light);
    }

    public void onDraw(Canvas canvas) {
        Bitmap bmp;
        if (canvas != null) {
            synchronized (this.barLock) {
                boolean suspended = this.mVisualizer.mSuspended;
                float[] gainsPaint = suspended ? this.mGainsUser : this.mGains;
                if (this.mScaledBg != null && !this.mScaledBg.isRecycled()) {
                    canvas.drawBitmap(this.mScaledBg, 0.0f, 0.0f, (Paint) null);
                }
                if (this.mScaledBarBlueLight != null) {
                    boolean enabled = this.mEnabled;
                    int barHeight = this.mScaledBarBlueLight.getHeight();
                    int h = this.mHeight - barHeight;
                    Paint line_paint = new Paint();
                    line_paint.setColor(ConstValue.TEXT_COLOR_BLACK);
                    int bar_width = (this.mWidth - 1) / 20;
                    int bar_height = (this.mHeight - 1) / 48;
                    for (int c = 0; c < 20; c++) {
                        int x = (bar_width * c) + 1;
                        canvas.drawLine(x - 1, 0.0f, x - 1, this.mHeight, line_paint);
                        int excitation = (int) (convertValue(this.mExcitations[c], 47.0f) + 0.5f);
                        for (int r = 0; r < 48; r++) {
                            int y = (bar_height * r) + 1;
                            if (c == 0) {
                                canvas.drawLine(0.0f, y - 1, this.mWidth, y - 1, line_paint);
                            }
                            if (!enabled || suspended || excitation < 47 - r) {
                                bmp = this.mScaledBarEmpty;
                            } else if (r < 12) {
                                bmp = this.mScaledBarRed;
                            } else if (r < 18) {
                                bmp = this.mScaledBarYellow;
                            } else {
                                bmp = this.mScaledBarBlue;
                            }
                            if (bmp != null && !bmp.isRecycled()) {
                                canvas.drawBitmap(bmp, x, y, (Paint) null);
                            }
                        }
                        if (enabled) {
                            int gainY = (int) (convertValue(gainsPaint[c], h) + (barHeight / 2));
                            canvas.drawBitmap(this.mScaledBarBlueLight, Math.round(x), (this.mHeight - barHeight) - gainY, (Paint) null);
                        }
                    }
                }
            }
        }
    }

    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        synchronized (this.barLock) {
            int barw = ((w - 1) / 20) - 1;
            int barh = ((h - 1) / 48) - 1;
            if (barw > 0 && barh > 0) {
                this.mWidth = w;
                this.mHeight = h;
                if (this.mScaledBg != null) {
                    this.mScaledBg.recycle();
                    this.mScaledBg = null;
                }
                if (this.mScaledBarEmpty != null) {
                    this.mScaledBarEmpty.recycle();
                    this.mScaledBarEmpty = null;
                }
                if (this.mScaledBarBlue != null) {
                    this.mScaledBarBlue.recycle();
                    this.mScaledBarBlue = null;
                }
                if (this.mScaledBarYellow != null) {
                    this.mScaledBarYellow.recycle();
                    this.mScaledBarYellow = null;
                }
                if (this.mScaledBarRed != null) {
                    this.mScaledBarRed.recycle();
                    this.mScaledBarRed = null;
                }
                if (this.mScaledBarBlueLight != null) {
                    this.mScaledBarBlueLight.recycle();
                    this.mScaledBarBlueLight = null;
                }
                this.mScaledBg = Bitmap.createScaledBitmap(this.mBg.getBitmap(), this.mWidth, h, true);
                this.mScaledBarEmpty = Bitmap.createScaledBitmap(this.mBarEmpty.getBitmap(), barw, barh, true);
                this.mScaledBarBlue = Bitmap.createScaledBitmap(this.mBarBlue.getBitmap(), barw, barh, true);
                this.mScaledBarYellow = Bitmap.createScaledBitmap(this.mBarYellow.getBitmap(), barw, barh, true);
                this.mScaledBarRed = Bitmap.createScaledBitmap(this.mBarRed.getBitmap(), barw, barh, true);
                this.mScaledBarBlueLight = Bitmap.createScaledBitmap(this.mBarBlueLight.getBitmap(), barw, barh, true);
            }
        }
    }

    private static float convertValue(float dB, float height) {
        float abs = dB - (-12.0f);
        float v = (abs * height) / 48.0f;
        return (int) v;
    }

    public void setExcitations(float[] excitations) {
        System.arraycopy(excitations, 0, this.mExcitations, 0, this.mExcitations.length);
    }

    public void setEnabled(boolean enabled) {
        this.mEnabled = enabled;
    }
}
