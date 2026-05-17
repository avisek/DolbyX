package com.dolby;

import android.content.Context;
import android.util.Log;

/* JADX INFO: loaded from: classes.dex */
public class DolbyWidgetExtraLargeProvider extends AbstractDolbyWidgetProvider implements IDolbyWidgetUpdateStatus {
    private static DolbyWidgetExtraLargeProvider sInstance;

    static {
        addWidgetExtraLargeClass(DolbyWidgetExtraLargeProvider.class);
    }

    public static synchronized DolbyWidgetExtraLargeProvider getInstance() {
        if (sInstance == null) {
            sInstance = new DolbyWidgetExtraLargeProvider();
        }
        return sInstance;
    }

    @Override // com.dolby.AbstractDolbyWidgetProvider, android.appwidget.AppWidgetProvider
    public void onEnabled(Context context) {
        super.onEnabled(context);
        sendInitIntent(getClass().getName());
        Log.d(Tag.WIDGET, "ExtraLargeWidget.sendout init intent");
    }

    @Override // com.dolby.IDolbyWidgetUpdateStatus
    public void notifyStatusUpdate(DsService service, DsWidgetStatus status) {
        if (hasInstances(service)) {
            mDsOn = status.getOn();
            mSelectedProfile = status.getProfile();
            updateWidgets(DolbyWidgetExtraLargeProvider.class, true, true);
        }
    }
}
