package com.dolby.ds1appUI;

import android.dolby.DsClientSettings;
import android.view.View;

/* JADX INFO: loaded from: classes.dex */
public interface IDsFragEqualizerPresetsObserver {
    void chooseProfile(int i);

    void displayTooltip(View view, int i, int i2);

    void equalizerPresetsAreAlive();

    void onDsClientUseChanged(boolean z);

    void onEqualizerEditStart();

    void onProfileSettingsChanged(int i, DsClientSettings dsClientSettings);

    void resetEqUserGains();

    void setUserProfilePopulated();
}
