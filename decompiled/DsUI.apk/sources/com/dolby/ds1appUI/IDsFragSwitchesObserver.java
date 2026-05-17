package com.dolby.ds1appUI;

import android.dolby.DsClientSettings;
import android.view.View;

/* JADX INFO: loaded from: classes.dex */
public interface IDsFragSwitchesObserver {
    void displayTooltip(View view, int i, int i2);

    void onProfileSettingsChanged(int i, DsClientSettings dsClientSettings);

    void setUserProfilePopulated();

    void switchesAreAlive();
}
