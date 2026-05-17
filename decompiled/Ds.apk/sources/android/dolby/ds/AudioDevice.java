package android.dolby.ds;

/* JADX INFO: loaded from: classes.dex */
public enum AudioDevice {
    DEVICE_EARPIECE(1),
    DEVICE_SPEAKER(2),
    DEVICE_WIRED_HEADSET(4),
    DEVICE_WIRED_HEADPHONE(8),
    DEVICE_BLUETOOTH_SCO(16),
    DEVICE_BLUETOOTH_SCO_HEADSET(32),
    DEVICE_BLUETOOTH_SCO_CARKIT(64),
    DEVICE_BLUETOOTH_A2DP(128),
    DEVICE_BLUETOOTH_A2DP_HEADPHONES(256),
    DEVICE_BLUETOOTH_A2DP_SPEAKER(512),
    DEVICE_AUX_DIGITAL(1024),
    DEVICE_ANLG_DOCK_HEADSET(2048),
    DEVICE_DGTL_DOCK_HEADSET(4096),
    DEVICE_USB_ACCESSORY(8192),
    DEVICE_USB_DEVICE(16384),
    DEVICE_REMOTE_SUBMIX(32768);

    private int value;

    public int toInt() {
        return this.value;
    }

    AudioDevice(int value) {
        this.value = value;
    }
}
