package com.dolby;

import android.content.Context;
import android.util.Log;

/* JADX INFO: loaded from: classes.dex */
public class DolbyWidgetSmallProvider extends AbstractDolbyWidgetProvider implements IDolbyWidgetUpdateStatus {
    private static DolbyWidgetSmallProvider sInstance;

    static {
        addWidgetSmallClass(DolbyWidgetSmallProvider.class);
    }

    static synchronized DolbyWidgetSmallProvider getInstance() {
        if (sInstance == null) {
            sInstance = new DolbyWidgetSmallProvider();
        }
        return sInstance;
    }

    @Override // com.dolby.AbstractDolbyWidgetProvider, android.appwidget.AppWidgetProvider
    public void onEnabled(Context context) {
        super.onEnabled(context);
        sendInitIntent(getClass().getName());
        Log.d(Tag.WIDGET, "SmallWidget.sendout init intent");
    }

    @Override // com.dolby.IDolbyWidgetUpdateStatus
    public void notifyStatusUpdate(DsService service, DsWidgetStatus status) {
        if (hasInstances(service)) {
            mDsOn = status.getOn();
            mSelectedProfile = status.getProfile();
            mModified = status.getModified();
            if (mModified) {
                mSelectedProfileName = status.getProfileName();
            }
            updateWidgets(DolbyWidgetSmallProvider.class, false, false);
        }
    }
}
