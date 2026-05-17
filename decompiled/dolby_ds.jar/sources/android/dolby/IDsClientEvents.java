package android.dolby;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public interface IDsClientEvents {
    void onClientConnected();

    void onClientDisconnected();

    void onDsOn(boolean z);

    void onEqSettingsChanged(int i, int i2);

    void onProfileNameChanged(int i, String str);

    void onProfileSelected(int i);

    void onProfileSettingsChanged(int i);
}
