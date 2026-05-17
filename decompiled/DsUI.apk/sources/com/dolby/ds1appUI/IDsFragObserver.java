package com.dolby.ds1appUI;

import android.dolby.DsClient;

/* JADX INFO: loaded from: classes.dex */
public interface IDsFragObserver {
    void exitActivity();

    DsClient getDsClient();

    boolean isDolbyClientConnected();

    void onDsApiError();

    boolean useDsApiOnUiEvent();
}
