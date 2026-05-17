package com.dolby.ds1appUI;

/* JADX INFO: loaded from: classes.dex */
public interface IDsFragProfileEditorObserver {
    int getProfileSelected();

    void onProfileNameEditEnded();

    void onProfileNameEditStarted();

    void profileEditorIsAlive();

    void profileReset(int i);
}
