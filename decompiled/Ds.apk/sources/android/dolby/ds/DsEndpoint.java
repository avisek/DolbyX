package android.dolby.ds;

/* JADX INFO: loaded from: classes.dex */
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
