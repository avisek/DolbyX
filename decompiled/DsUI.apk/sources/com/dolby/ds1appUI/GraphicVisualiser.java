package com.dolby.ds1appUI;

import android.content.Context;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.AttributeSet;
import android.util.Log;
import android.view.MotionEvent;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import com.dolby.ds1appCoreUI.Tag;

/* JADX INFO: loaded from: classes.dex */
public class GraphicVisualiser extends SurfaceView implements SurfaceHolder.Callback {
    private static final Handler PAINT_HANDLER;
    private static final boolean USE_PAINT_HANDLER = true;
    private static final boolean USE_UI_PAINT_HANDLER = false;
    private final Runnable mCanvasPaint;
    public boolean mEnableEditTouch;
    private GraphicEqualizerPainter mEqualizer;
    private boolean mFragmentIsActive;
    private final float[] mGainsUi;
    private final float[] mGainsUserSmoothed;
    private SurfaceHolder mHolder;
    private GraphicVisualiserPainter mPainter;
    private boolean mSufraceCreated;
    public boolean mSuspended;

    static {
        HandlerThread ht = new HandlerThread("VisPaint", -4);
        ht.start();
        Handler h = new Handler(ht.getLooper());
        PAINT_HANDLER = h;
    }

    public GraphicVisualiser(Context context) {
        super(context);
        this.mSuspended = false;
        this.mEnableEditTouch = true;
        this.mFragmentIsActive = false;
        this.mGainsUi = new float[20];
        this.mGainsUserSmoothed = new float[20];
        this.mCanvasPaint = new Runnable() { // from class: com.dolby.ds1appUI.GraphicVisualiser.1
            @Override // java.lang.Runnable
            public void run() {
                if (GraphicVisualiser.this.mSufraceCreated && GraphicVisualiser.this.mFragmentIsActive) {
                    Canvas c = null;
                    synchronized (this) {
                        try {
                            try {
                                c = GraphicVisualiser.this.mHolder.lockCanvas();
                                if (c != null) {
                                    GraphicVisualiser.this.mPainter.onDraw(c);
                                    GraphicVisualiser.this.mEqualizer.onDraw(c);
                                }
                            } catch (Exception e) {
                                Log.d(Tag.MAIN, e.getMessage());
                                if (c != null) {
                                    GraphicVisualiser.this.mHolder.unlockCanvasAndPost(c);
                                }
                            }
                            if (GraphicVisualiser.this.mEqualizer.isAnimating()) {
                                GraphicVisualiser.PAINT_HANDLER.removeCallbacks(this);
                                GraphicVisualiser.PAINT_HANDLER.postDelayed(this, 30L);
                            }
                        } finally {
                            if (c != null) {
                                GraphicVisualiser.this.mHolder.unlockCanvasAndPost(c);
                            }
                        }
                    }
                }
            }
        };
        init(context);
    }

    public GraphicVisualiser(Context context, AttributeSet attrs) {
        super(context, attrs);
        this.mSuspended = false;
        this.mEnableEditTouch = true;
        this.mFragmentIsActive = false;
        this.mGainsUi = new float[20];
        this.mGainsUserSmoothed = new float[20];
        this.mCanvasPaint = new Runnable() { // from class: com.dolby.ds1appUI.GraphicVisualiser.1
            @Override // java.lang.Runnable
            public void run() {
                if (GraphicVisualiser.this.mSufraceCreated && GraphicVisualiser.this.mFragmentIsActive) {
                    Canvas c = null;
                    synchronized (this) {
                        try {
                            try {
                                c = GraphicVisualiser.this.mHolder.lockCanvas();
                                if (c != null) {
                                    GraphicVisualiser.this.mPainter.onDraw(c);
                                    GraphicVisualiser.this.mEqualizer.onDraw(c);
                                }
                            } catch (Exception e) {
                                Log.d(Tag.MAIN, e.getMessage());
                                if (c != null) {
                                    GraphicVisualiser.this.mHolder.unlockCanvasAndPost(c);
                                }
                            }
                            if (GraphicVisualiser.this.mEqualizer.isAnimating()) {
                                GraphicVisualiser.PAINT_HANDLER.removeCallbacks(this);
                                GraphicVisualiser.PAINT_HANDLER.postDelayed(this, 30L);
                            }
                        } finally {
                            if (c != null) {
                                GraphicVisualiser.this.mHolder.unlockCanvasAndPost(c);
                            }
                        }
                    }
                }
            }
        };
        init(context);
    }

    public GraphicVisualiser(Context context, AttributeSet attrs, int defStyle) {
        super(context, attrs, defStyle);
        this.mSuspended = false;
        this.mEnableEditTouch = true;
        this.mFragmentIsActive = false;
        this.mGainsUi = new float[20];
        this.mGainsUserSmoothed = new float[20];
        this.mCanvasPaint = new Runnable() { // from class: com.dolby.ds1appUI.GraphicVisualiser.1
            @Override // java.lang.Runnable
            public void run() {
                if (GraphicVisualiser.this.mSufraceCreated && GraphicVisualiser.this.mFragmentIsActive) {
                    Canvas c = null;
                    synchronized (this) {
                        try {
                            try {
                                c = GraphicVisualiser.this.mHolder.lockCanvas();
                                if (c != null) {
                                    GraphicVisualiser.this.mPainter.onDraw(c);
                                    GraphicVisualiser.this.mEqualizer.onDraw(c);
                                }
                            } catch (Exception e) {
                                Log.d(Tag.MAIN, e.getMessage());
                                if (c != null) {
                                    GraphicVisualiser.this.mHolder.unlockCanvasAndPost(c);
                                }
                            }
                            if (GraphicVisualiser.this.mEqualizer.isAnimating()) {
                                GraphicVisualiser.PAINT_HANDLER.removeCallbacks(this);
                                GraphicVisualiser.PAINT_HANDLER.postDelayed(this, 30L);
                            }
                        } finally {
                            if (c != null) {
                                GraphicVisualiser.this.mHolder.unlockCanvasAndPost(c);
                            }
                        }
                    }
                }
            }
        };
        init(context);
    }

    private void init(Context context) {
        this.mPainter = new GraphicVisualiserPainter(context, this, this.mGainsUi, this.mGainsUserSmoothed);
        this.mEqualizer = new GraphicEqualizerPainter(context, this, this.mGainsUi, this.mGainsUserSmoothed);
        this.mPainter.setEnabled(isEnabled());
        this.mEqualizer.setEnabled(isEnabled());
        this.mHolder = getHolder();
        this.mHolder.addCallback(this);
    }

    public GraphicEqualizerPainter getEqualizer() {
        return this.mEqualizer;
    }

    @Override // android.view.View
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        Log.d(Tag.MAIN, "GraphicVisualiser.onSizeChanged");
        super.onSizeChanged(w, h, oldw, oldh);
        int bar_width = ((w - 1) / 20) - 1;
        int bar_height = ((h - 1) / 48) - 1;
        int neww = ((bar_width + 1) * 20) + 1;
        int newh = ((bar_height + 1) * 48) + 1;
        this.mPainter.onSizeChanged(neww, newh, oldw, oldh);
        this.mEqualizer.onSizeChanged(neww, newh, oldw, oldh, getHeight());
        this.mHolder.setFixedSize(neww, newh);
    }

    public void setExcitations(float[] excitations) {
        this.mPainter.setExcitations(excitations);
    }

    public void onVisualizerUpdate(float[] gains) {
        System.arraycopy(gains, 0, this.mGainsUi, 0, gains.length);
    }

    @Override // android.view.View
    public boolean onTouchEvent(MotionEvent event) {
        if (this.mEnableEditTouch) {
            return this.mEqualizer.onTouchEvent(event);
        }
        return true;
    }

    @Override // android.view.View
    protected void drawableStateChanged() {
        Log.d(Tag.MAIN, "GraphicVisualiser.drawableStateChanged mSufraceCreated:" + this.mSufraceCreated);
        super.drawableStateChanged();
        if (this.mSufraceCreated) {
            setEnabled(ViewTools.testDrawableState(getDrawableState(), ENABLED_STATE_SET));
            this.mPainter.setEnabled(isEnabled());
            this.mEqualizer.setEnabled(isEnabled());
            repaint(true);
        }
    }

    public void repaint() {
        repaint(false);
    }

    public void repaint(boolean force) {
        if (Thread.currentThread() == PAINT_HANDLER.getLooper().getThread()) {
            this.mCanvasPaint.run();
            return;
        }
        if (force) {
            synchronized (this.mCanvasPaint) {
                PAINT_HANDLER.removeCallbacks(this.mCanvasPaint);
                PAINT_HANDLER.post(this.mCanvasPaint);
            }
            return;
        }
        PAINT_HANDLER.removeCallbacks(this.mCanvasPaint);
        PAINT_HANDLER.post(this.mCanvasPaint);
    }

    public void setActiveStatus(boolean active) {
        this.mFragmentIsActive = active;
    }

    @Override // android.view.SurfaceHolder.Callback
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        Log.d(Tag.MAIN, "GraphicVisualiser.surfaceChanged " + width + " x " + height + " format: " + format);
        if (this.mSufraceCreated) {
            repaint(true);
        }
    }

    @Override // android.view.SurfaceHolder.Callback
    public void surfaceCreated(SurfaceHolder holder) {
        Log.d(Tag.MAIN, "GraphicVisualiser.surfaceCreated");
        this.mSufraceCreated = true;
        repaint(true);
    }

    @Override // android.view.SurfaceHolder.Callback
    public void surfaceDestroyed(SurfaceHolder holder) {
        Log.d(Tag.MAIN, "GraphicVisualiser.surfaceDestroyed");
        this.mSufraceCreated = false;
    }

    boolean isSurfaceCreated() {
        return this.mSufraceCreated;
    }

    public void setSuspended(boolean suspended) {
        this.mSuspended = suspended;
        this.mEqualizer.readUserGainsFromEngine();
    }
}
