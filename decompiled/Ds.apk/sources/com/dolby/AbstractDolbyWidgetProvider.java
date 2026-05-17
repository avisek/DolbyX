package com.dolby;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.dolby.DsCommon;
import android.graphics.Color;
import android.util.Log;
import android.widget.RemoteViews;
import java.util.HashSet;
import java.util.Set;

/* JADX INFO: loaded from: classes.dex */
public abstract class AbstractDolbyWidgetProvider extends AppWidgetProvider {
    private static DS1Application mContext;
    private static final Set<Class<?>> mWidgetSmallClasses = new HashSet();
    private static final Set<Class<?>> mWidgetExtraLargeClasses = new HashSet();
    protected static boolean mDsOn = false;
    protected static boolean mModified = false;
    protected static int mSelectedProfile = 0;
    protected static String mSelectedProfileName = "";

    protected static void addWidgetSmallClass(Class<?> cls) {
        mWidgetSmallClasses.add(cls);
    }

    protected static void addWidgetExtraLargeClass(Class<?> cls) {
        mWidgetExtraLargeClasses.add(cls);
    }

    @Override // android.appwidget.AppWidgetProvider, android.content.BroadcastReceiver
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
    }

    @Override // android.appwidget.AppWidgetProvider
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        Log.d(Tag.WIDGET, "Widget.onUpdate " + this);
        sendInitIntent(getClass().getName());
        for (int appWidgetId : appWidgetIds) {
            Log.d(Tag.WIDGET, "appWidgetId: " + appWidgetId);
            RemoteViews rv = populateRemoteViews(context, null, false, isExtraLargeWidget(this));
            appWidgetManager.updateAppWidget(appWidgetId, rv);
        }
        super.onUpdate(context, appWidgetManager, appWidgetIds);
    }

    private static void updateAllWidgets() {
        Log.d(Tag.WIDGET, "updateAllWidgets");
        ensureInitState();
        AppWidgetManager manager = AppWidgetManager.getInstance(mContext);
        for (Class<?> cls : mWidgetSmallClasses) {
            updateWidgets(manager, cls, false, false);
        }
        for (Class<?> cls2 : mWidgetExtraLargeClasses) {
            updateWidgets(manager, cls2, true, true);
        }
    }

    private static void updateWidgets(AppWidgetManager manager, Class<?> widgetClass, boolean large, boolean extraLarge) {
        ComponentName cn = new ComponentName(mContext, widgetClass);
        int[] widgetIds = manager.getAppWidgetIds(cn);
        if (widgetIds != null && widgetIds.length != 0) {
            RemoteViews rv = populateRemoteViews(mContext, null, large, extraLarge);
            manager.updateAppWidget(widgetIds, rv);
        }
    }

    protected static void updateWidgets(Class<?> widgetClass, boolean large, boolean extraLarge) {
        ensureInitState();
        AppWidgetManager manager = AppWidgetManager.getInstance(mContext);
        updateWidgets(manager, widgetClass, large, extraLarge);
    }

    private static boolean isExtraLargeWidget(Object o) {
        for (Class<?> cls = o.getClass(); cls != null; cls = cls.getSuperclass()) {
            for (Class<?> wcls : mWidgetExtraLargeClasses) {
                if (cls.equals(wcls)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static RemoteViews populateRemoteViews(Context context, RemoteViews rv, boolean large, boolean extraLarge) {
        if (rv == null) {
            if (extraLarge) {
                rv = new RemoteViews(context.getPackageName(), R.layout.widget_profile_layout);
            } else {
                rv = new RemoteViews(context.getPackageName(), R.layout.widget_status_layout);
            }
        }
        boolean on = mDsOn;
        int profile = mSelectedProfile;
        int[] anames = {R.string.movie, R.string.music, R.string.game, R.string.voice, R.string.preset_1, R.string.preset_2};
        int[] aimgon = {R.drawable.movieon, R.drawable.musicon, R.drawable.gameon, R.drawable.voiceon, R.drawable.preset1on, R.drawable.preset2on};
        int[] aimgoff = {R.drawable.movieoff, R.drawable.musicoff, R.drawable.gameoff, R.drawable.voiceoff, R.drawable.preset1off, R.drawable.preset2off};
        int[] aimgdis = {R.drawable.moviedis, R.drawable.musicdis, R.drawable.gamedis, R.drawable.voicedis, R.drawable.preset1dis, R.drawable.preset2dis};
        int[] aprofiles = {R.id.profile_1, R.id.profile_2, R.id.profile_3, R.id.profile_4, R.id.profile_5, R.id.profile_6};
        rv.setViewVisibility(R.id.powerButtonOff, !on ? 0 : 4);
        rv.setViewVisibility(R.id.powerButtonOn, on ? 0 : 4);
        rv.setImageViewResource(R.id.dsLogo, on ? R.drawable.dslogo : R.drawable.dslogodis);
        PendingIntent pendingIntent = createWidgetIntent(context, 17);
        rv.setOnClickPendingIntent(R.id.powerButtonOff, pendingIntent);
        PendingIntent pendingIntent2 = createWidgetIntent(context, 16);
        rv.setOnClickPendingIntent(R.id.powerButtonOn, pendingIntent2);
        PendingIntent pendingIntent3 = createWidgetIntent(context, 48);
        rv.setOnClickPendingIntent(R.id.dsLogo, pendingIntent3);
        if (large || extraLarge) {
            if (on) {
                int i = 0;
                for (int prof : aprofiles) {
                    rv.setImageViewResource(prof, profile == i ? aimgon[i] : aimgoff[i]);
                    rv.setInt(prof, "setBackgroundResource", profile == i ? R.drawable.topselectedbackground : 0);
                    i++;
                }
                PendingIntent pendingIntent4 = createWidgetIntent(context, 32);
                rv.setOnClickPendingIntent(R.id.profile_1, pendingIntent4);
                PendingIntent pendingIntent5 = createWidgetIntent(context, 33);
                rv.setOnClickPendingIntent(R.id.profile_2, pendingIntent5);
                PendingIntent pendingIntent6 = createWidgetIntent(context, 34);
                rv.setOnClickPendingIntent(R.id.profile_3, pendingIntent6);
                PendingIntent pendingIntent7 = createWidgetIntent(context, 35);
                rv.setOnClickPendingIntent(R.id.profile_4, pendingIntent7);
                PendingIntent pendingIntent8 = createWidgetIntent(context, 36);
                rv.setOnClickPendingIntent(R.id.profile_5, pendingIntent8);
                PendingIntent pendingIntent9 = createWidgetIntent(context, 37);
                rv.setOnClickPendingIntent(R.id.profile_6, pendingIntent9);
            } else {
                int i2 = 0;
                for (int prof2 : aprofiles) {
                    rv.setImageViewResource(prof2, aimgdis[i2]);
                    rv.setInt(prof2, "setBackgroundResource", 0);
                    rv.setOnClickPendingIntent(prof2, null);
                    i2++;
                }
            }
        } else {
            if (4 > profile) {
                rv.setTextViewText(R.id.name, context.getString(anames[profile]));
            } else if (mModified) {
                rv.setTextViewText(R.id.name, mSelectedProfileName);
            } else {
                rv.setTextViewText(R.id.name, context.getString(anames[profile]));
            }
            if (on) {
                rv.setImageViewResource(R.id.profile_1, aimgon[profile]);
                rv.setInt(R.id.widget_bottom1, "setBackgroundResource", R.drawable.topselectedbackgroundwsmall);
                PendingIntent pendingIntent10 = createWidgetIntent(context, 48);
                rv.setOnClickPendingIntent(R.id.widget_bottom1, pendingIntent10);
                rv.setTextColor(R.id.name, -1);
            } else {
                rv.setImageViewResource(R.id.profile_1, aimgdis[profile]);
                rv.setInt(R.id.widget_bottom1, "setBackgroundColor", Integer.MIN_VALUE);
                rv.setOnClickPendingIntent(R.id.widget_bottom1, null);
                rv.setTextColor(R.id.name, Color.rgb(65, 114, 155));
            }
        }
        return rv;
    }

    private static PendingIntent createWidgetIntent(Context context, int code) {
        ComponentName serviceName = new ComponentName(context, (Class<?>) DsService.class);
        Intent intent = new Intent();
        intent.setComponent(serviceName);
        if (code == 17 || code == 16) {
            intent.setAction(DsCommon.ONOFF_ACTION);
            intent.putExtra(DsCommon.CMDNAME, DsCommon.CMDONOFF);
        } else if ((code == 32 || code == 33 || code == 34) && mDsOn) {
            intent.setAction(DsCommon.SELECTPROFILE_ACTION);
            if (code == 32) {
                intent.putExtra(DsCommon.CMDNAME, 0);
            } else if (code == 33) {
                intent.putExtra(DsCommon.CMDNAME, 1);
            } else {
                intent.putExtra(DsCommon.CMDNAME, 2);
            }
        } else if ((code == 35 || code == 36 || code == 37) && mDsOn) {
            intent.setAction(DsCommon.SELECTPROFILE_ACTION);
            if (code == 35) {
                intent.putExtra(DsCommon.CMDNAME, 3);
            } else if (code == 36) {
                intent.putExtra(DsCommon.CMDNAME, 4);
            } else {
                intent.putExtra(DsCommon.CMDNAME, 5);
            }
        } else if (code == 48) {
            intent.setAction(DsCommon.LAUNCH_DOLBY_APP_ACTION);
        }
        return PendingIntent.getService(context, code, intent, 0);
    }

    protected boolean hasInstances(Context context) {
        AppWidgetManager appWidgetManager = AppWidgetManager.getInstance(context);
        int[] appWidgetIds = appWidgetManager.getAppWidgetIds(new ComponentName(context, getClass()));
        return appWidgetIds.length > 0;
    }

    protected void sendInitIntent(String className) {
        Intent intent = new Intent(DsCommon.INIT_ACTION);
        intent.putExtra(DsCommon.CMDNAME, DsCommon.CMDINIT);
        intent.putExtra(DsCommon.WIDGET_CLASS, className);
        ensureInitState();
        mContext.sendBroadcast(intent);
    }

    @Override // android.appwidget.AppWidgetProvider
    public void onEnabled(Context context) {
        Log.d(Tag.WIDGET, "Widget.onEnabled");
        super.onEnabled(context);
        ensureInitState();
    }

    @Override // android.appwidget.AppWidgetProvider
    public void onDisabled(Context context) {
        Log.d(Tag.WIDGET, "Widget.onDisabled");
        super.onDisabled(context);
        destruct();
    }

    private static void ensureInitState() {
        if (mContext == null) {
            mContext = DS1Application.getStaticContext();
        }
    }

    private void destruct() {
    }
}
