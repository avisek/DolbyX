package android.dolby.ds;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public enum DsEndpoint {
    GENERIC(AudioDevice.DEVICE_WIRED_HEADPHONE);

    private AudioDevice _device;

    DsEndpoint(AudioDevice device) {
        this._device = device;
    }

    public AudioDevice toDevice() {
        return this._device;
    }
}
