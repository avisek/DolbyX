package com.dolby.ds1appUI;

import android.content.Context;
import android.content.res.Resources;
import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.CornerPathEffect;
import android.graphics.MaskFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PathEffect;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.util.Log;
import android.view.MotionEvent;
import com.dolby.ds1appCoreUI.Configuration;
import com.dolby.ds1appCoreUI.DS1Application;
import com.dolby.ds1appCoreUI.Tag;
import com.dolby.ds1appCoreUI.Tools;

/* JADX INFO: loaded from: classes.dex */
public class GraphicEqualizerPainter {
    private static final boolean DISPLAY_DEBUG_BARS = false;
    private static final boolean DISPLAY_DEBUG_TEXT = false;
    private static float[] GAIN_SMOOTHER = null;
    private static float[][] GAIN_SMOOTHER_INV = null;
    private static final int IDLE_HIDE_DELAY = 5000;
    private static final int MAX_ALPHA = 255;
    private static final long MIN_RECALC_POS_INTERVAL = 60;
    private static final int SHOW_HIDE_ANIMATION_DURATION = 250;
    private IDsActivityCommonTemp mActivity;
    private MaskFilter mBlur;
    private final Context mContext;
    private DsClient mDSClient;
    private String[] mDefaultProfileNames;
    private final FPSCounter mDrawFpsCounter;
    private float mEditGain;
    private PathEffect mEffect1;
    private boolean mForceSmoothenCurve;
    private float[] mGainsSmooth;
    private final float[] mGainsUi;
    private int mHeight;
    private final Runnable mHideAction;
    private long mHideAnimEndTimestamp;
    private IEqualizerChangeListener mListener;
    private Paint mPaintCurve1;
    private Paint mPaintCurve2;
    private float mPrevEditGain;
    private final Runnable mRecalcPositions;
    private long mShowAnimEndTimestamp;
    private Drawable mSliderBg;
    private Drawable mSliderThumb;
    private Drawable mSliderThumbBright1;
    private Drawable mSliderThumbBright2;
    private Drawable mSliderThumbBright3;
    private final FPSCounter mSmoothFpsCounter;
    private long mSmoothenTimestamp;
    private int mUserBandsUpdated;
    private int mViewHeight;
    private boolean mVisible;
    private final GraphicVisualiser mVisualizer;
    private int mWidth;
    private long recalcPosTimestamp;
    private static int GAIN_SMOOTH_LENGTH = 2;
    private static final float[] GAIN_SMOOTHER_TABLET = {0.25f, 0.5f, 0.25f};
    private static final float GEQ_TRANS_TIME = 0.3f;
    private static final float[] GAIN_SMOOTHER_MOBILE = {0.1f, 0.25f, GEQ_TRANS_TIME, 0.25f, 0.1f};
    private static final float[][] GAIN_SMOOTHER_INV_TABLET = {new float[]{1.95f, -1.85f, 1.75f, -1.65f, 1.55f, -1.45f, 1.35f, -1.25f, 1.15f, -1.05f, 0.95f, -0.85f, 0.75f, -0.65f, 0.55f, -0.45f, 0.35f, -0.25f, 0.15f, -0.05f}, new float[]{-1.85f, 5.55f, -5.25f, 4.95f, -4.65f, 4.35f, -4.05f, 3.75f, -3.45f, 3.15f, -2.85f, 2.55f, -2.25f, 1.95f, -1.65f, 1.35f, -1.05f, 0.75f, -0.45f, 0.15f}, new float[]{1.75f, -5.25f, 8.75f, -8.25f, 7.75f, -7.25f, 6.75f, -6.25f, 5.75f, -5.25f, 4.75f, -4.25f, 3.75f, -3.25f, 2.75f, -2.25f, 1.75f, -1.25f, 0.75f, -0.25f}, new float[]{-1.65f, 4.95f, -8.25f, 11.55f, -10.85f, 10.15f, -9.45f, 8.75f, -8.05f, 7.35f, -6.65f, 5.95f, -5.25f, 4.55f, -3.85f, 3.15f, -2.45f, 1.75f, -1.05f, 0.35f}, new float[]{1.55f, -4.65f, 7.75f, -10.85f, 13.95f, -13.05f, 12.15f, -11.25f, 10.35f, -9.45f, 8.55f, -7.65f, 6.75f, -5.85f, 4.95f, -4.05f, 3.15f, -2.25f, 1.35f, -0.45f}, new float[]{-1.45f, 4.35f, -7.25f, 10.15f, -13.05f, 15.95f, -14.85f, 13.75f, -12.65f, 11.55f, -10.45f, 9.35f, -8.25f, 7.15f, -6.05f, 4.95f, -3.85f, 2.75f, -1.65f, 0.55f}, new float[]{1.35f, -4.05f, 6.75f, -9.45f, 12.15f, -14.85f, 17.55f, -16.25f, 14.95f, -13.65f, 12.35f, -11.05f, 9.75f, -8.45f, 7.15f, -5.85f, 4.55f, -3.25f, 1.95f, -0.65f}, new float[]{-1.25f, 3.75f, -6.25f, 8.75f, -11.25f, 13.75f, -16.25f, 18.75f, -17.25f, 15.75f, -14.25f, 12.75f, -11.25f, 9.75f, -8.25f, 6.75f, -5.25f, 3.75f, -2.25f, 0.75f}, new float[]{1.15f, -3.45f, 5.75f, -8.05f, 10.35f, -12.65f, 14.95f, -17.25f, 19.55f, -17.85f, 16.15f, -14.45f, 12.75f, -11.05f, 9.35f, -7.65f, 5.95f, -4.25f, 2.55f, -0.85f}, new float[]{-1.05f, 3.15f, -5.25f, 7.35f, -9.45f, 11.55f, -13.65f, 15.75f, -17.85f, 19.95f, -18.05f, 16.15f, -14.25f, 12.35f, -10.45f, 8.55f, -6.65f, 4.75f, -2.85f, 0.95f}, new float[]{0.95f, -2.85f, 4.75f, -6.65f, 8.55f, -10.45f, 12.35f, -14.25f, 16.15f, -18.05f, 19.95f, -17.85f, 15.75f, -13.65f, 11.55f, -9.45f, 7.35f, -5.25f, 3.15f, -1.05f}, new float[]{-0.85f, 2.55f, -4.25f, 5.95f, -7.65f, 9.35f, -11.05f, 12.75f, -14.45f, 16.15f, -17.85f, 19.55f, -17.25f, 14.95f, -12.65f, 10.35f, -8.05f, 5.75f, -3.45f, 1.15f}, new float[]{0.75f, -2.25f, 3.75f, -5.25f, 6.75f, -8.25f, 9.75f, -11.25f, 12.75f, -14.25f, 15.75f, -17.25f, 18.75f, -16.25f, 13.75f, -11.25f, 8.75f, -6.25f, 3.75f, -1.25f}, new float[]{-0.65f, 1.95f, -3.25f, 4.55f, -5.85f, 7.15f, -8.45f, 9.75f, -11.05f, 12.35f, -13.65f, 14.95f, -16.25f, 17.55f, -14.85f, 12.15f, -9.45f, 6.75f, -4.05f, 1.35f}, new float[]{0.55f, -1.65f, 2.75f, -3.85f, 4.95f, -6.05f, 7.15f, -8.25f, 9.35f, -10.45f, 11.55f, -12.65f, 13.75f, -14.85f, 15.95f, -13.05f, 10.15f, -7.25f, 4.35f, -1.45f}, new float[]{-0.45f, 1.35f, -2.25f, 3.15f, -4.05f, 4.95f, -5.85f, 6.75f, -7.65f, 8.55f, -9.45f, 10.35f, -11.25f, 12.15f, -13.05f, 13.95f, -10.85f, 7.75f, -4.65f, 1.55f}, new float[]{0.35f, -1.05f, 1.75f, -2.45f, 3.15f, -3.85f, 4.55f, -5.25f, 5.95f, -6.65f, 7.35f, -8.05f, 8.75f, -9.45f, 10.15f, -10.85f, 11.55f, -8.25f, 4.95f, -1.65f}, new float[]{-0.25f, 0.75f, -1.25f, 1.75f, -2.25f, 2.75f, -3.25f, 3.75f, -4.25f, 4.75f, -5.25f, 5.75f, -6.25f, 6.75f, -7.25f, 7.75f, -8.25f, 8.75f, -5.25f, 1.75f}, new float[]{0.15f, -0.45f, 0.75f, -1.05f, 1.35f, -1.65f, 1.95f, -2.25f, 2.55f, -2.85f, 3.15f, -3.45f, 3.75f, -4.05f, 4.35f, -4.65f, 4.95f, -5.25f, 5.55f, -1.85f}, new float[]{-0.05f, 0.15f, -0.25f, 0.35f, -0.45f, 0.55f, -0.65f, 0.75f, -0.85f, 0.95f, -1.05f, 1.15f, -1.25f, 1.35f, -1.45f, 1.55f, -1.65f, 1.75f, -1.85f, 1.95f}};
    private static final float[][] GAIN_SMOOTHER_INV_MOBILE = {new float[]{5.974947f, -9.560246f, 4.623703f, 2.184113f, -1.405723f, -5.037043f, 6.72579f, -0.373153f, -5.246158f, 2.457422f, 3.802012f, -3.388747f, -3.831564f, 7.782701f, -3.292202f, -2.149938f, -0.373736f, 7.831958f, -9.791641f, 4.067505f}, new float[]{-13.18045f, 26.889568f, -8.440565f, -16.616169f, 12.818645f, 12.013738f, -18.509293f, -5.198427f, 25.670954f, -14.322612f, -9.700973f, 8.24131f, 18.63522f, -32.736935f, 15.034376f, 5.795506f, 3.615226f, -31.273586f, 37.815147f, -15.550682f}, new float[]{4.113967f, -5.082324f, -8.952654f, 27.343687f, -22.909416f, 2.706435f, 2.555595f, 15.42156f, -30.077356f, 19.833288f, -0.460646f, 1.423582f, -21.68288f, 31.254782f, -16.186623f, -0.514169f, -6.608782f, 27.27624f, -30.892204f, 12.43792f}, new float[]{8.344117f, -24.502037f, 31.520372f, -26.155107f, 23.737633f, -25.17765f, 25.598623f, -21.652584f, 16.542082f, -15.21636f, 16.947493f, -16.422272f, 11.712018f, -7.165604f, 6.88614f, -8.576313f, 6.984354f, -1.781692f, -1.944189f, 1.320977f}, new float[]{-6.226015f, 18.838387f, -25.465256f, 22.713017f, -21.256725f, 29.827518f, -32.115906f, 21.236002f, -10.054364f, 11.890145f, -20.536371f, 19.570402f, -6.987888f, -1.7907f, -2.949217f, 10.644462f, -6.298866f, -7.02248f, 12.790858f, -5.807003f}, new float[]{-6.57178f, 12.226384f, -0.075773f, -20.060266f, 26.38381f, -17.815672f, 15.614193f, -21.487722f, 25.032099f, -19.33689f, 11.35104f, -11.459458f, 17.905647f, -19.426456f, 12.146804f, -5.3923f, 7.700833f, -14.015736f, 13.270786f, -4.989541f}, new float[]{10.133236f, -20.743704f, 6.736928f, 20.0557f, -28.624014f, 15.294314f, -9.239926f, 28.721205f, -43.695007f, 30.8794f, -8.676571f, 9.569534f, -31.39762f, 40.597473f, -22.548088f, 3.502315f, -11.207588f, 33.28477f, -35.796864f, 14.1545f}, new float[]{1.60317f, -7.413822f, 15.52777f, -20.585884f, 21.812786f, -24.179914f, 30.94837f, -38.77726f, 42.735046f, -33.69684f, 22.031742f, -22.049196f, 30.53481f, -31.571955f, 20.416708f, -10.61373f, 13.679281f, -21.826826f, 19.646841f, -7.221095f}, new float[]{-11.75217f, 31.36132f, -33.37552f, 18.735258f, -13.362724f, 29.278507f, -46.57073f, 43.262848f, -28.278479f, 28.055967f, -36.890873f, 35.49263f, -19.920393f, 7.494313f, -10.815301f, 18.863667f, -13.528656f, -3.225425f, 12.305661f, -6.129906f}, new float[]{5.809602f, -16.52896f, 20.08894f, -15.15948f, 13.144674f, -21.076637f, 31.06733f, -32.140617f, 26.696478f, -26.911022f, 36.472343f, -35.048363f, 18.78496f, -6.087141f, 10.011543f, -18.681467f, 13.101933f, 4.347852f, -13.483305f, 6.591341f}, new float[]{6.591341f, -13.483305f, 4.347852f, 13.101933f, -18.681467f, 10.011543f, -6.087141f, 18.78496f, -35.048363f, 36.472343f, -26.911022f, 26.696478f, -32.140617f, 31.06733f, -21.076637f, 13.144674f, -15.15948f, 20.08894f, -16.52896f, 5.809602f}, new float[]{-6.129906f, 12.305661f, -3.225425f, -13.528656f, 18.863667f, -10.815301f, 7.494313f, -19.920393f, 35.49263f, -36.890873f, 28.055967f, -28.278479f, 43.262848f, -46.57073f, 29.278507f, -13.362724f, 18.735258f, -33.37552f, 31.36132f, -11.75217f}, new float[]{-7.221095f, 19.646841f, -21.826826f, 13.679281f, -10.61373f, 20.416708f, -31.571955f, 30.53481f, -22.049196f, 22.031742f, -33.69684f, 42.735046f, -38.77726f, 30.94837f, -24.179914f, 21.812786f, -20.585884f, 15.52777f, -7.413822f, 1.60317f}, new float[]{14.1545f, -35.796864f, 33.28477f, -11.207588f, 3.502315f, -22.548088f, 40.597473f, -31.39762f, 9.569534f, -8.676571f, 30.8794f, -43.695007f, 28.721205f, -9.239926f, 15.294314f, -28.624014f, 20.0557f, 6.736928f, -20.743704f, 10.133236f}, new float[]{-4.989541f, 13.270786f, -14.015736f, 7.700833f, -5.3923f, 12.146804f, -19.426456f, 17.905647f, -11.459458f, 11.35104f, -19.33689f, 25.032099f, -21.487722f, 15.614193f, -17.815672f, 26.38381f, -20.060266f, -0.075773f, 12.226384f, -6.57178f}, new float[]{-5.807003f, 12.790858f, -7.02248f, -6.298866f, 10.644462f, -2.949217f, -1.7907f, -6.987888f, 19.570402f, -20.536371f, 11.890145f, -10.054364f, 21.236002f, -32.115906f, 29.827518f, -21.256725f, 22.713017f, -25.465256f, 18.838387f, -6.226015f}, new float[]{1.320977f, -1.944189f, -1.781692f, 6.984354f, -8.576313f, 6.88614f, -7.165604f, 11.712018f, -16.422272f, 16.947493f, -15.21636f, 16.542082f, -21.652584f, 25.598623f, -25.17765f, 23.737633f, -26.155107f, 31.520372f, -24.502037f, 8.344117f}, new float[]{12.43792f, -30.892204f, 27.27624f, -6.608782f, -0.514169f, -16.186623f, 31.254782f, -21.68288f, 1.423582f, -0.460646f, 19.833288f, -30.077356f, 15.42156f, 2.555595f, 2.706435f, -22.909416f, 27.343687f, -8.952654f, -5.082324f, 4.113967f}, new float[]{-15.550682f, 37.815147f, -31.273586f, 3.615226f, 5.795506f, 15.034376f, -32.736935f, 18.63522f, 8.24131f, -9.700973f, -14.322612f, 25.670954f, -5.198427f, -18.509293f, 12.013738f, 12.818645f, -16.616169f, -8.440565f, 26.889568f, -13.18045f}, new float[]{4.067505f, -9.791641f, 7.831958f, -0.373736f, -2.149938f, -3.292202f, 7.782701f, -3.831564f, -3.388747f, 3.802012f, 2.457422f, -5.246158f, -0.373153f, 6.72579f, -5.037043f, -1.405723f, 2.184113f, 4.623703f, -9.560246f, 5.974947f}};
    private final float[] mUserGainsTemp = new float[(GAIN_SMOOTH_LENGTH * 2) + 20];
    private final EQTouchQueue mEventQueue = new EQTouchQueue(20);
    private final float[] mGainsSmoothOld = new float[20];
    private int mEditBand = -1;
    private int mPrevEditBand = -1;
    private boolean mNotifyListener = false;
    private int mProfile = -1;
    private int mEqPreset = -1;
    private boolean mEnabled = true;
    private boolean mMobileLayout = false;
    private final float TABLET_LAYOUT_INITIAL_COLUMN = 0.0f;
    private final float TABLET_LAYOUT_INITIAL_STEP = 1.0f;
    private final float MOBILE_LAYOUT_INITIAL_COLUMN = 0.0f;
    private final float MOBILE_LAYOUT_INITIAL_STEP = 4.75f;
    private final Paint mPaintRed = new Paint();
    private final Paint mPaintGreen = new Paint();

    public GraphicEqualizerPainter(Context context, GraphicVisualiser visualizer, float[] gainsUi, float[] gainsUser) {
        this.mPaintRed.setColor(-788561792);
        this.mPaintRed.setTextSize(20.0f);
        this.mPaintGreen.setColor(-796852352);
        this.mDrawFpsCounter = new FPSCounter();
        this.mSmoothFpsCounter = new FPSCounter();
        this.mHideAction = new Runnable() { // from class: com.dolby.ds1appUI.GraphicEqualizerPainter.1
            @Override // java.lang.Runnable
            public void run() {
                GraphicEqualizerPainter.this.animateVisibility(false);
                GraphicEqualizerPainter.this.mVisualizer.repaint(true);
            }
        };
        this.mForceSmoothenCurve = false;
        this.recalcPosTimestamp = 0L;
        this.mRecalcPositions = new Runnable() { // from class: com.dolby.ds1appUI.GraphicEqualizerPainter.2
            @Override // java.lang.Runnable
            public void run() {
                GraphicEqualizerPainter.this.doRecalcPositions();
            }
        };
        this.mContext = context;
        this.mVisualizer = visualizer;
        this.mGainsUi = gainsUi;
        this.mGainsSmooth = gainsUser;
        init();
    }

    private void init() {
        Resources res = this.mContext.getResources();
        this.mMobileLayout = res.getBoolean(R.bool.newLayout);
        if (this.mMobileLayout) {
            GAIN_SMOOTHER = GAIN_SMOOTHER_MOBILE;
            GAIN_SMOOTHER_INV = GAIN_SMOOTHER_INV_MOBILE;
        } else {
            GAIN_SMOOTHER = GAIN_SMOOTHER_TABLET;
            GAIN_SMOOTHER_INV = GAIN_SMOOTHER_INV_TABLET;
            GAIN_SMOOTH_LENGTH = 1;
        }
        this.mSliderThumb = res.getDrawable(R.drawable.eq_thumb);
        this.mSliderThumbBright1 = res.getDrawable(R.drawable.eq_thumb);
        this.mSliderThumbBright2 = res.getDrawable(R.drawable.eq_thumb);
        this.mSliderThumbBright3 = res.getDrawable(R.drawable.eq_thumb_touch_state);
        this.mSliderBg = res.getDrawable(R.drawable.eq_bar);
        this.mDefaultProfileNames = new String[6];
        this.mDefaultProfileNames[0] = res.getString(R.string.movie);
        this.mDefaultProfileNames[1] = res.getString(R.string.music);
        this.mDefaultProfileNames[2] = res.getString(R.string.game);
        this.mDefaultProfileNames[3] = res.getString(R.string.voice);
        this.mDefaultProfileNames[4] = res.getString(R.string.preset_1);
        this.mDefaultProfileNames[5] = res.getString(R.string.preset_2);
        float scale = 1.0f;
        switch (res.getDisplayMetrics().densityDpi) {
            case 120:
                scale = 0.75f;
                break;
            case 240:
                scale = 1.5f;
                break;
            case 320:
                scale = 2.0f;
                break;
        }
        this.mBlur = new BlurMaskFilter(4.0f * scale, BlurMaskFilter.Blur.NORMAL);
        this.mEffect1 = new CornerPathEffect(10.0f * scale);
        this.mPaintCurve1 = new Paint(1);
        this.mPaintCurve1.setStyle(Paint.Style.STROKE);
        this.mPaintCurve1.setStrokeWidth(3.0f * scale);
        this.mPaintCurve1.setColor(-797584641);
        this.mPaintCurve1.setPathEffect(this.mEffect1);
        this.mPaintCurve2 = new Paint(1);
        this.mPaintCurve2.setStyle(Paint.Style.STROKE);
        this.mPaintCurve2.setStrokeCap(Paint.Cap.ROUND);
        this.mPaintCurve2.setStrokeWidth(10.0f * scale);
        this.mPaintCurve2.setColor(-2139761921);
        this.mPaintCurve2.setMaskFilter(this.mBlur);
        this.mPaintCurve2.setPathEffect(this.mEffect1);
        if (this.mSliderBg instanceof BitmapDrawable) {
            ((BitmapDrawable) this.mSliderBg).setGravity(113);
        }
        this.mVisible = false;
    }

    protected void onSizeChanged(int w, int h, int oldw, int oldh, int viewH) {
        this.mWidth = w;
        this.mHeight = h;
        this.mViewHeight = viewH;
        if (this.mSliderBg != null) {
            this.mSliderBg.setBounds(0, 0, this.mSliderBg.getIntrinsicWidth(), h);
        }
        if (this.mSliderThumb != null) {
            this.mSliderThumb.setBounds(0, 0, this.mSliderThumb.getIntrinsicWidth(), this.mSliderThumb.getIntrinsicWidth());
        }
        if (this.mSliderThumbBright1 != null) {
            this.mSliderThumbBright1.setBounds(0, 0, this.mSliderThumbBright1.getIntrinsicWidth(), this.mSliderThumbBright1.getIntrinsicWidth());
        }
        if (this.mSliderThumbBright2 != null) {
            this.mSliderThumbBright2.setBounds(0, 0, this.mSliderThumbBright2.getIntrinsicWidth(), this.mSliderThumbBright2.getIntrinsicWidth());
        }
        if (this.mSliderThumbBright3 != null) {
            this.mSliderThumbBright3.setBounds(0, 0, this.mSliderThumbBright3.getIntrinsicWidth(), this.mSliderThumbBright3.getIntrinsicWidth());
        }
    }

    private void handleNewTouchEvents() {
        float newUserGain;
        int size = this.mEventQueue.size();
        boolean suspended = this.mVisualizer.mSuspended;
        for (int i = 0; i < size; i++) {
            int b = this.mEventQueue.getBandAt(i);
            if (suspended) {
                newUserGain = this.mEventQueue.getGainAt(i);
            } else {
                float currentUiGain = this.mGainsUi[b];
                float engineGain = currentUiGain - this.mGainsSmooth[b];
                newUserGain = this.mEventQueue.getGainAt(i) - engineGain;
            }
            for (int bb = b; bb <= (GAIN_SMOOTH_LENGTH * 2) + b; bb++) {
                this.mUserGainsTemp[bb] = newUserGain;
            }
        }
        this.mEventQueue.reset();
    }

    public boolean isModified() {
        for (int b = 0; b < this.mGainsSmooth.length; b++) {
            if (this.mGainsSmooth[b] != 0.0f) {
                return true;
            }
        }
        return false;
    }

    private void smoothenCurve() {
        Configuration conf = MainActivity.getConfiguration();
        if (conf != null) {
            long now = System.currentTimeMillis();
            if (now - this.mSmoothenTimestamp >= 1000) {
                this.mSmoothenTimestamp = now;
            }
            long delta = now - this.mSmoothenTimestamp;
            float fDelta = delta / 1000.0f;
            float[] tempGains = this.mUserGainsTemp;
            boolean redraw = false;
            float fAlpha = (float) Math.pow(0.5d, fDelta / GEQ_TRANS_TIME);
            for (int b = 0; b < (GAIN_SMOOTH_LENGTH * 2) + 20; b++) {
                float diff = tempGains[b] - conf.getMaxEditGain();
                if (diff <= 0.0f) {
                    float diff2 = conf.getMinEditGain() - tempGains[b];
                    if (diff2 > 0.0f) {
                        if (diff2 < 0.02f) {
                            tempGains[b] = conf.getMinEditGain();
                        } else if (diff2 < 0.2f) {
                            tempGains[b] = conf.getMinEditGain();
                        } else {
                            tempGains[b] = (tempGains[b] * fAlpha) + ((1.0f - fAlpha) * conf.getMinEditGain());
                        }
                    }
                } else if (diff < 0.02f) {
                    tempGains[b] = conf.getMaxEditGain();
                } else if (diff < 0.2f) {
                    tempGains[b] = conf.getMaxEditGain();
                } else {
                    tempGains[b] = (tempGains[b] * fAlpha) + ((1.0f - fAlpha) * conf.getMaxEditGain());
                }
            }
            System.arraycopy(this.mGainsSmooth, 0, this.mGainsSmoothOld, 0, 20);
            for (int b2 = 0; b2 < 20; b2++) {
                float fGain = 0.0f;
                int i = 0;
                int bb = b2;
                while (i <= GAIN_SMOOTH_LENGTH * 2) {
                    fGain += GAIN_SMOOTHER[i] * tempGains[bb];
                    i++;
                    bb++;
                }
                if (this.mGainsSmooth[b2] != fGain) {
                    float absDiff = Math.abs(this.mGainsSmooth[b2] - fGain);
                    if (absDiff > 0.02f) {
                        this.mGainsSmooth[b2] = fGain;
                        if (!redraw) {
                            redraw = true;
                        }
                    }
                }
            }
            this.mSmoothenTimestamp = now;
            this.mForceSmoothenCurve = redraw;
        }
    }

    private void updateEqUserGainsInEngine() {
        Configuration conf;
        Log.d(Tag.MAIN, "GraphicEqualizerPainter.updateEqUserGainsInEngine");
        if (this.mActivity.useDsApiOnUiEvent() && (conf = MainActivity.getConfiguration()) != null) {
            try {
                int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDSClient);
                DsClientSettings stg = DsClientCache.INSTANCE.getProfileSettings(this.mDSClient, selectedProfile);
                boolean isGeqOn = stg.getGeqOn();
                float[] userGain = new float[20];
                int counter = 0;
                float minEditGain = conf.getMinEditGain();
                boolean changed = false;
                boolean suspended = this.mVisualizer.mSuspended;
                for (int b = 0; b < 20; b++) {
                    try {
                        userGain[b] = this.mGainsSmooth[b];
                        float old = this.mGainsSmoothOld[b];
                        float diff = userGain[b] - old;
                        if (!changed) {
                            changed = diff != 0.0f;
                        }
                        if (userGain[b] != 0.0f && stg != null && !isGeqOn) {
                            isGeqOn = true;
                            Log.d(Tag.MAIN, "GraphicEqualizerPainter.setGeqOn true");
                            stg.setGeqOn(true);
                        }
                        if (userGain[b] < minEditGain) {
                            userGain[b] = minEditGain;
                        } else if (userGain[b] > 36.0f) {
                            userGain[b] = 36.0f;
                        }
                        counter++;
                    } catch (Exception e) {
                        e.printStackTrace();
                        return;
                    }
                }
                if (suspended && changed) {
                    Log.d(Tag.MAIN, "mGainsUi: " + Tools.floatArrayToString(this.mGainsUi));
                    this.mVisualizer.repaint(true);
                }
                if (changed) {
                    try {
                        this.mDSClient.setGeq(selectedProfile, this.mEqPreset, userGain);
                        Log.d(Tag.MAIN, "GraphicEqualizerPainter DsClientCache.INSTANCE.setProfileSettings");
                        DsClientCache.INSTANCE.setProfileSettings(this.mDSClient, selectedProfile, stg);
                    } catch (Exception e2) {
                        e2.printStackTrace();
                        return;
                    }
                }
                this.mUserBandsUpdated = counter;
                if (this.mNotifyListener) {
                    if (this.mListener != null) {
                        this.mListener.onEqualizerEditStart();
                    }
                    this.mNotifyListener = false;
                }
            } catch (Exception e3) {
                e3.printStackTrace();
            }
        }
    }

    protected void onDraw(Canvas canvas) {
        Drawable d;
        if (this.mVisible) {
            if (isEnabled() || isAnimating()) {
                long now = System.currentTimeMillis();
                float[] gainsPaint = this.mVisualizer.mSuspended ? this.mGainsSmooth : this.mGainsUi;
                int alpha = MAX_ALPHA;
                if (now < this.mShowAnimEndTimestamp) {
                    long delay = now - (this.mShowAnimEndTimestamp - 250);
                    alpha = (int) ((255 * delay) / 250);
                } else if (now < this.mHideAnimEndTimestamp) {
                    long left = this.mHideAnimEndTimestamp - now;
                    alpha = (int) ((255 * left) / 250);
                }
                if (alpha < 0) {
                    alpha = 0;
                } else if (alpha > MAX_ALPHA) {
                    alpha = MAX_ALPHA;
                }
                if (alpha < MAX_ALPHA) {
                    canvas.saveLayerAlpha(0.0f, 0.0f, this.mWidth, this.mHeight, alpha, 31);
                } else if (this.mHideAnimEndTimestamp != 0 && now > this.mHideAnimEndTimestamp) {
                    this.mHideAnimEndTimestamp = 0L;
                    this.mVisible = false;
                    return;
                }
                int width = getWidth();
                float initialI = 0.0f;
                float initialStep = 1.0f;
                if (this.mMobileLayout) {
                    initialI = 0.0f;
                    initialStep = 4.75f;
                }
                int x0 = width / 40;
                for (float i = initialI; i < 20.0f; i += initialStep) {
                    int x = (int) (x0 + ((width * i) / 20.0f));
                    if (this.mSliderBg != null) {
                        canvas.save();
                        canvas.translate(x - (this.mSliderBg.getBounds().width() / 2), 0.0f);
                        this.mSliderBg.draw(canvas);
                        canvas.restore();
                    }
                    if (this.mEditBand == -1) {
                        d = this.mSliderThumb;
                    } else {
                        int dist = (int) Math.abs(i - this.mEditBand);
                        if (dist == 0) {
                            d = this.mSliderThumbBright3;
                        } else if (dist == 1) {
                            d = this.mSliderThumbBright2;
                        } else if (dist == 2) {
                            d = this.mSliderThumbBright1;
                        } else {
                            d = this.mSliderThumb;
                        }
                    }
                    if (d != null) {
                        int dw = d.getBounds().width();
                        int dh = d.getBounds().height();
                        canvas.save();
                        canvas.translate(x - (dw / 2), translateGaindBToY(gainsPaint, i) - (dh / 2));
                        d.draw(canvas);
                        canvas.restore();
                    }
                }
                if (this.mMobileLayout) {
                    Path mPath = new Path();
                    float yThumb = translateGaindBToY(gainsPaint, 0.0f);
                    mPath.moveTo(0.0f, yThumb);
                    for (int i2 = 0; i2 < 20; i2++) {
                        yThumb = translateGaindBToY(gainsPaint, i2);
                        mPath.lineTo(x0 + ((i2 * width) / 20), yThumb);
                    }
                    mPath.lineTo(x0 + width, yThumb);
                    canvas.drawPath(mPath, this.mPaintCurve2);
                    canvas.drawPath(mPath, this.mPaintCurve1);
                }
                if (alpha < MAX_ALPHA) {
                    canvas.restore();
                }
            }
        }
    }

    private boolean isEnabled() {
        return this.mEnabled;
    }

    public void setEnabled(boolean b) {
        this.mEnabled = b;
    }

    public final int getWidth() {
        return this.mWidth;
    }

    public final int getHeight() {
        return this.mHeight;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void animateVisibility(boolean visible) {
        if (!isAnimating()) {
            Log.d(Tag.MAIN, "animateVisibility " + visible);
            preventHiding();
            long now = System.currentTimeMillis();
            long until = now + 250;
            if (visible) {
                this.mVisible = true;
                this.mShowAnimEndTimestamp = until;
                delayHide(250L);
                return;
            }
            this.mHideAnimEndTimestamp = until;
        }
    }

    private void preventHiding() {
        DS1Application.HANDLER.removeCallbacks(this.mHideAction);
    }

    private void delayHide() {
        delayHide(0L);
    }

    private void delayHide(long add) {
        DS1Application.HANDLER.removeCallbacks(this.mHideAction);
        DS1Application.HANDLER.postDelayed(this.mHideAction, 5000 + add);
    }

    public boolean onTouchEvent(MotionEvent event) {
        Log.d(Tag.MAIN, "GraphicEqualizerPainter.onTouchEvent");
        if (this.mEnabled) {
            int action = event.getAction();
            if (action == 0) {
                this.mNotifyListener = true;
                preventHiding();
                if (!isAnimatedVisible() || !this.mVisible) {
                    animateVisibility(true);
                    this.mRecalcPositions.run();
                }
            }
            this.mPrevEditBand = this.mEditBand;
            this.mPrevEditGain = this.mEditGain;
            if (2 == action || action == 0) {
                float eX = event.getX();
                float eY = event.getY();
                if (eX >= 0.0f && eX < this.mWidth && eY >= 0.0f && eY < this.mViewHeight) {
                    int iSetCenter = Math.max(0, Math.min(19, (int) ((20.0f * eX) / this.mWidth)));
                    if (this.mMobileLayout && (iSetCenter = Math.round(4.75f * Math.round(((double) (iSetCenter + 1)) / 5.0d))) >= 20) {
                        iSetCenter = 19;
                    }
                    this.mEditBand = iSetCenter;
                    float fTrackdB = translateYtoGaindB(eY);
                    float fSetdBdraw = Math.max(-12.0f, Math.min(36.0f, fTrackdB));
                    this.mEditGain = fSetdBdraw;
                    this.mEventQueue.add(iSetCenter, fSetdBdraw);
                    if (this.mVisualizer.mSuspended) {
                        this.mRecalcPositions.run();
                    }
                }
            } else if (1 == action) {
                this.mEditBand = -1;
                this.mPrevEditBand = -1;
                delayHide();
                this.mForceSmoothenCurve = true;
                this.mRecalcPositions.run();
            }
        }
        return true;
    }

    private int getVerticalThumbPadding() {
        if (this.mSliderThumb != null) {
            return this.mSliderThumb.getBounds().height() / 4;
        }
        return 0;
    }

    private float translateYtoGaindB(float y) {
        int verticalThumbPadding = getVerticalThumbPadding();
        int height = this.mViewHeight;
        int paddedHeight = height - (verticalThumbPadding * 2);
        float valueAbs = (((height - verticalThumbPadding) - y) * 48.0f) / paddedHeight;
        float value = Math.max(-12.0f, Math.min(36.0f, valueAbs - 12.0f));
        return value;
    }

    private float translateGaindBToY(float[] gainval, float freq) {
        float value;
        if (this.mMobileLayout) {
            double ba1 = Math.floor(freq);
            double ba2 = Math.ceil(freq);
            if (ba1 != ba2) {
                float val1 = gainval[(int) ba1];
                float val2 = gainval[(int) ba2];
                float inc = (float) (((double) freq) - ba1);
                value = ((val2 - val1) * inc) + val1;
            } else {
                value = gainval[(int) freq];
            }
        } else {
            value = gainval[(int) freq];
        }
        float verticalThumbPadding = getVerticalThumbPadding();
        float height = getHeight();
        float paddedHeight = height - (2.0f * verticalThumbPadding);
        float valueAbs = value - (-12.0f);
        float paddedY = (valueAbs * paddedHeight) / 48.0f;
        return (height - verticalThumbPadding) - paddedY;
    }

    private static int translateEqPresetIndex(int eqPreset) {
        if (eqPreset == -1) {
            return 0;
        }
        return eqPreset + 1;
    }

    public void switchPreset(int profile, int eqPreset, boolean updateInDs) {
        Log.d(Tag.MAIN, "GraphicEqualizerPainter.switchPreset " + profile + " " + eqPreset);
        int eqPreset2 = translateEqPresetIndex(eqPreset);
        if (this.mProfile != profile || this.mEqPreset != eqPreset2) {
            Log.i(Tag.MAIN, "updateUserGains " + profile + " " + eqPreset2);
            this.mProfile = profile;
            this.mEqPreset = eqPreset2;
            readUserGainsFromEngine();
            onIEqPresetChanged();
            if (updateInDs) {
                updateGeqOnInDs();
            }
            this.mRecalcPositions.run();
        }
    }

    public void setEqualizerListener(IEqualizerChangeListener listener) {
        this.mListener = listener;
    }

    public void setActivity(IDsActivityCommonTemp activity) {
        this.mActivity = activity;
    }

    public void setDsClient(DsClient dsc) {
        this.mDSClient = dsc;
    }

    public void hide() {
        animateVisibility(false);
        this.mVisualizer.repaint(false);
    }

    public void setVisible(boolean b) {
        this.mVisible = b;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void doRecalcPositions() {
        if (this.mVisualizer.isSurfaceCreated()) {
            long beginTime = System.currentTimeMillis();
            long delay = beginTime - this.recalcPosTimestamp;
            long minInterval = MIN_RECALC_POS_INTERVAL;
            if (this.mVisualizer.mSuspended) {
                minInterval = MIN_RECALC_POS_INTERVAL / 2;
            }
            if (delay < minInterval) {
                long postDelay = (minInterval - delay) + 1;
                Log.d(Tag.MAIN, "GraphicEqualizerPainter.doRecalcPositions ignore");
                DS1Application.HANDLER.postDelayed(this.mRecalcPositions, postDelay);
                return;
            }
            Log.d(Tag.MAIN, "GraphicEqualizerPainter.doRecalcPositions");
            DS1Application.HANDLER.removeCallbacks(this.mRecalcPositions);
            this.recalcPosTimestamp = beginTime;
            if (this.mEventQueue.size() >= 4) {
                Log.d(Tag.MAIN, "mTouchEvents: " + this.mEventQueue.size());
            }
            int editBand = this.mEditBand;
            float editGain = this.mEditGain;
            if (this.mEventQueue.size() == 0 && editBand != -1) {
                this.mEventQueue.add(editBand, editGain);
            }
            if (this.mEventQueue.size() != 0 || this.mForceSmoothenCurve) {
                handleNewTouchEvents();
                smoothenCurve();
                updateEqUserGainsInEngine();
            }
            if (this.mForceSmoothenCurve) {
                delayHide();
            }
            if (isVisible()) {
                DS1Application.HANDLER.postDelayed(this.mRecalcPositions, MIN_RECALC_POS_INTERVAL - (System.currentTimeMillis() - beginTime));
            }
        }
    }

    void readUserGainsFromEngine() {
        Log.d(Tag.MAIN, "GraphicEqualizerPainter.readUserGainsFromEngine");
        boolean changed = false;
        try {
            DsClientSettings stgs = this.mDSClient.getProfileSettings(this.mProfile);
            DsClientCache.INSTANCE.cacheProfileSettings(this.mDSClient, this.mProfile, stgs);
            this.mGainsSmooth = this.mDSClient.getGeq(this.mProfile, this.mEqPreset);
            Configuration conf = MainActivity.getConfiguration();
            for (int i = 0; i < 20; i++) {
                if (this.mGainsSmooth[i] > conf.getMaxEditGain()) {
                    this.mGainsSmooth[i] = conf.getMaxEditGain();
                    changed = true;
                }
                if (this.mGainsSmooth[i] < conf.getMinEditGain()) {
                    this.mGainsSmooth[i] = conf.getMinEditGain();
                    changed = true;
                }
            }
            if (changed) {
                try {
                    this.mDSClient.setGeq(this.mProfile, this.mEqPreset, this.mGainsSmooth);
                    Log.d(Tag.MAIN, "GraphicEqualizerPainter DsClientCache.INSTANCE.setProfileSettings");
                    DsClientCache.INSTANCE.setProfileSettings(this.mDSClient, this.mProfile, stgs);
                } catch (Exception e) {
                    e.printStackTrace();
                    return;
                }
            }
            calculateTempGainsFromSmoothed();
        } catch (Exception e2) {
            e2.printStackTrace();
        }
    }

    private void calculateTempGainsFromSmoothed() {
        Log.d(Tag.MAIN, "GraphicEqualizerPainter.calculateTempGainsFromSmoothed");
        for (int b = 0; b < 20; b++) {
            this.mUserGainsTemp[GAIN_SMOOTH_LENGTH + b] = 0.0f;
            for (int bb = 0; bb < 20; bb++) {
                float[] fArr = this.mUserGainsTemp;
                int i = GAIN_SMOOTH_LENGTH + b;
                fArr[i] = fArr[i] + (GAIN_SMOOTHER_INV[b][bb] * this.mGainsSmooth[bb]);
            }
        }
        for (int i2 = 0; i2 < GAIN_SMOOTH_LENGTH; i2++) {
            this.mUserGainsTemp[i2] = this.mUserGainsTemp[GAIN_SMOOTH_LENGTH];
            this.mUserGainsTemp[(((GAIN_SMOOTH_LENGTH * 2) + 20) - 1) - i2] = this.mUserGainsTemp[(GAIN_SMOOTH_LENGTH + 20) - 1];
        }
    }

    private void onIEqPresetChanged() {
        this.mEventQueue.reset();
        this.mSmoothenTimestamp = 0L;
        smoothenCurve();
        System.arraycopy(this.mGainsSmooth, 0, this.mGainsSmoothOld, 0, 20);
        Log.d(Tag.MAIN, "usergains " + this.mEqPreset + ": " + Tools.floatArrayToString(this.mGainsSmooth));
    }

    public void resetUserGains(boolean updateInDs) {
        Log.d(Tag.MAIN, "GraphicEqualizerPainter.resetUserGains " + updateInDs);
        if (this.mProfile != -1 && this.mEqPreset != -1) {
            for (int b = 0; b < this.mUserGainsTemp.length; b++) {
                this.mUserGainsTemp[b] = 0.0f;
            }
            for (int b2 = 0; b2 < this.mGainsSmooth.length; b2++) {
                this.mGainsSmooth[b2] = 0.0f;
            }
            this.mEventQueue.reset();
            onIEqPresetChanged();
            if (updateInDs) {
                updateGeqOnInDs();
            }
        }
    }

    private void updateGeqOnInDs() {
        Log.d(Tag.MAIN, "GraphicEqualizerPainter.updateGeqOnInDs");
        try {
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDSClient);
            DsClientSettings stg = DsClientCache.INSTANCE.getProfileSettings(this.mDSClient, selectedProfile);
            boolean geqOn = false;
            try {
                this.mDSClient.setGeq(selectedProfile, this.mEqPreset, this.mGainsSmooth);
                int b = 0;
                while (true) {
                    if (b >= 20) {
                        break;
                    }
                    float userGain = this.mGainsSmooth[b];
                    if (userGain == 0.0f) {
                        b++;
                    } else {
                        geqOn = true;
                        break;
                    }
                }
                stg.setGeqOn(geqOn);
                try {
                    DsClientCache.INSTANCE.setProfileSettings(this.mDSClient, selectedProfile, stg);
                } catch (Exception e) {
                    e.printStackTrace();
                }
            } catch (Exception e2) {
                e2.printStackTrace();
            }
        } catch (Exception e3) {
            e3.printStackTrace();
        }
    }

    public boolean isAnimating() {
        long now = System.currentTimeMillis();
        return isAnimating(now);
    }

    private boolean isAnimating(long now) {
        return now < this.mHideAnimEndTimestamp || now < this.mShowAnimEndTimestamp;
    }

    private boolean isAnimatedVisible() {
        return System.currentTimeMillis() > this.mShowAnimEndTimestamp;
    }

    public boolean isVisible() {
        return this.mVisible;
    }

    private class EQTouchQueue {
        private final int[] mBands;
        private final float[] mGains;
        private int mSize = 0;

        public EQTouchQueue(int maxSize) {
            this.mBands = new int[maxSize];
            this.mGains = new float[maxSize];
        }

        public synchronized int size() {
            return this.mSize;
        }

        public synchronized void reset() {
            this.mSize = 0;
        }

        /* JADX WARN: Removed duplicated region for block: B:24:0x00a3 A[Catch: all -> 0x017b, TryCatch #0 {, blocks: (B:3:0x0001, B:5:0x0059, B:9:0x0069, B:12:0x0074, B:15:0x0079, B:19:0x0082, B:20:0x009a, B:24:0x00a3, B:26:0x00ae, B:30:0x0109, B:33:0x012d, B:35:0x0133, B:37:0x0143, B:40:0x0151, B:42:0x015c, B:47:0x017e), top: B:49:0x0001 }] */
        /*
            Code decompiled incorrectly, please refer to instructions dump.
            To view partially-correct code enable 'Show inconsistent code' option in preferences
        */
        public synchronized void add(int r18, float r19) {
            /*
                Method dump skipped, instruction units count: 390
                To view this dump change 'Code comments level' option to 'DEBUG'
            */
            throw new UnsupportedOperationException("Method not decompiled: com.dolby.ds1appUI.GraphicEqualizerPainter.EQTouchQueue.add(int, float):void");
        }

        public synchronized int getBandAt(int i) {
            return this.mBands[i];
        }

        public synchronized float getGainAt(int i) {
            return this.mGains[i];
        }
    }
}
