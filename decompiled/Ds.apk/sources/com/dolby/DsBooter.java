package com.dolby;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.dolby.IDs;
import android.util.Log;

/* JADX INFO: loaded from: classes.dex */
public class DsBooter extends BroadcastReceiver {
    @Override // android.content.BroadcastReceiver
    public void onReceive(Context context, Intent intent) {
        if (intent.getAction().equals("android.intent.action.BOOT_COMPLETED")) {
            Log.i("DsBooter", "startService()");
            context.startService(new Intent(IDs.class.getName()));
        }
    }
}
