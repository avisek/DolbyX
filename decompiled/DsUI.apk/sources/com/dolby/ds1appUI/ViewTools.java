package com.dolby.ds1appUI;

import android.app.Activity;
import android.graphics.Point;
import android.os.Looper;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.ViewTreeObserver;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.dolby.ds1appCoreUI.Tag;
import com.dolby.ds1appUI.Assets;

/* JADX INFO: loaded from: classes.dex */
public class ViewTools {
    private ViewTools() {
    }

    public static int getVisibleChildIndexAt(ViewGroup vg, float x, float y) {
        for (int i = 0; i < vg.getChildCount(); i++) {
            View ch = vg.getChildAt(i);
            if (x >= ch.getLeft() && x <= ch.getRight() && y >= ch.getTop() && y <= ch.getBottom() && ch.getVisibility() == 0) {
                return i;
            }
        }
        return -1;
    }

    public static View getVisibleChildViewAt(ViewGroup vg, float x, float y) {
        int n = getVisibleChildIndexAt(vg, x, y);
        if (n == -1) {
            return null;
        }
        return vg.getChildAt(n);
    }

    public static boolean testDrawableState(int[] state, int[] referenceState) {
        for (int i : referenceState) {
            boolean found = false;
            int j = 0;
            while (true) {
                if (j >= state.length) {
                    break;
                }
                if (i != state[j]) {
                    j++;
                } else {
                    found = true;
                    break;
                }
            }
            if (!found) {
                return false;
            }
        }
        return true;
    }

    public static boolean isUIThread() {
        return Thread.currentThread() == Looper.getMainLooper().getThread();
    }

    public static View showTooltip(Activity activity, final ViewGroup rootView, View pointTo, CharSequence title, CharSequence text) {
        final Point posPointTo = getRelativePosition(pointTo, rootView);
        posPointTo.x += pointTo.getWidth() / 2;
        final ViewGroup vTooltip = (ViewGroup) activity.getLayoutInflater().inflate(R.layout.tooltip2, (ViewGroup) null);
        final ViewGroup vTooltipMain = (ViewGroup) vTooltip.findViewById(R.id.main);
        TextView vTitle = (TextView) vTooltip.findViewById(R.id.title);
        TextView vText = (TextView) vTooltip.findViewById(R.id.text);
        final View vArrow = vTooltip.findViewById(R.id.bottom_arrow);
        if (activity.getResources().getString(R.string.tooltip_eq_title).contentEquals(title)) {
            vText.setMaxWidth(vText.getMaxWidth() * 2);
        }
        vTitle.setTypeface(Assets.getFont(Assets.FontType.REGULAR));
        vText.setTypeface(Assets.getFont(Assets.FontType.REGULAR));
        vTitle.setText(title);
        vText.setText(text);
        FrameLayout.LayoutParams lpArrow = (FrameLayout.LayoutParams) vArrow.getLayoutParams();
        int screenWidth = activity.getResources().getDisplayMetrics().widthPixels;
        if (posPointTo.x * 3 <= screenWidth) {
            lpArrow.gravity = 3;
        } else if (posPointTo.x * 3 >= screenWidth * 2) {
            lpArrow.gravity = 5;
        } else {
            lpArrow.gravity = 1;
        }
        FrameLayout.LayoutParams lpTooltip = new FrameLayout.LayoutParams(-1, -1);
        final FrameLayout.LayoutParams lpTooltipMain = (FrameLayout.LayoutParams) vTooltipMain.getLayoutParams();
        vTooltip.setVisibility(4);
        activity.addContentView(vTooltip, lpTooltip);
        vTooltip.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() { // from class: com.dolby.ds1appUI.ViewTools.1
            private int counter = 0;

            @Override // android.view.ViewTreeObserver.OnGlobalLayoutListener
            public void onGlobalLayout() {
                if (this.counter == 0) {
                    Point posArrow = ViewTools.getRelativePosition(vArrow, vTooltipMain);
                    Log.d(Tag.MAIN, "posArrow: " + posArrow);
                    lpTooltipMain.leftMargin = posPointTo.x - (posArrow.x + (vArrow.getWidth() / 2));
                    if (lpTooltipMain.leftMargin < 0) {
                        FrameLayout.LayoutParams vArrowlp = (FrameLayout.LayoutParams) vArrow.getLayoutParams();
                        vArrowlp.leftMargin += lpTooltipMain.leftMargin;
                        lpTooltipMain.leftMargin = 0;
                    }
                    lpTooltipMain.topMargin = posPointTo.y - vTooltipMain.getHeight();
                    lpTooltipMain.gravity = 7;
                    vTooltip.requestLayout();
                    vTooltipMain.requestLayout();
                } else {
                    vTooltip.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                    vTooltip.setVisibility(0);
                    rootView.bringChildToFront(vTooltip);
                    vTooltip.requestLayout();
                }
                this.counter++;
            }
        });
        vTooltip.setOnTouchListener(new View.OnTouchListener() { // from class: com.dolby.ds1appUI.ViewTools.2
            @Override // android.view.View.OnTouchListener
            public boolean onTouch(View v, MotionEvent event) {
                ViewTools.removeFromParent(vTooltip);
                return true;
            }
        });
        return vTooltip;
    }

    public static void removeFromParent(View v) {
        ViewParent vp = v.getParent();
        if (vp instanceof ViewGroup) {
            ((ViewGroup) vp).removeView(v);
        }
    }

    public static ViewGroup determineNativeViewContainer(Activity activity) {
        View view = new View(activity);
        activity.addContentView(view, new FrameLayout.LayoutParams(-2, -2));
        ViewParent rootView = view.getParent();
        removeFromParent(view);
        if (rootView instanceof ViewGroup) {
            return (ViewGroup) rootView;
        }
        return null;
    }

    public static Point getRelativePosition(View v, ViewGroup relativeTo) {
        if (v == null || relativeTo == null) {
            return null;
        }
        Point p = new Point(v.getLeft(), v.getTop());
        View view = v;
        while (true) {
            Object parent = view.getParent();
            if (parent != relativeTo && (parent instanceof View)) {
                view = (View) parent;
                p.x += view.getLeft();
                p.y += view.getTop();
            } else {
                return p;
            }
        }
    }
}
