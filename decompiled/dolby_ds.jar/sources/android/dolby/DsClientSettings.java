package android.dolby;

import android.os.Parcel;
import android.os.Parcelable;
import java.util.HashSet;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public class DsClientSettings implements Parcelable {
    public static final Parcelable.Creator<DsClientSettings> CREATOR;
    private static final String TAG = "DsClientSettings";
    public static final HashSet<String> basicProfileParams = new HashSet<>();
    private boolean isDialogEnhancerOn;
    private boolean isGeqOn;
    private boolean isHeadphoneVirtualizerOn;
    private boolean isSpeakerVirtualizerOn;
    private boolean isVolumeLevellerOn;

    static {
        basicProfileParams.add("geon");
        basicProfileParams.add("deon");
        basicProfileParams.add("dvle");
        basicProfileParams.add("vdhe");
        basicProfileParams.add("vspe");
        basicProfileParams.add("ieon");
        CREATOR = new Parcelable.Creator<DsClientSettings>() { // from class: android.dolby.DsClientSettings.1
            /* JADX WARN: Can't rename method to resolve collision */
            @Override // android.os.Parcelable.Creator
            public DsClientSettings createFromParcel(Parcel source) {
                return new DsClientSettings(source);
            }

            /* JADX WARN: Can't rename method to resolve collision */
            @Override // android.os.Parcelable.Creator
            public DsClientSettings[] newArray(int size) {
                return new DsClientSettings[size];
            }
        };
    }

    @Override // android.os.Parcelable
    public int describeContents() {
        return 0;
    }

    public DsClientSettings() {
        this.isGeqOn = false;
        this.isDialogEnhancerOn = false;
        this.isVolumeLevellerOn = false;
        this.isHeadphoneVirtualizerOn = false;
        this.isSpeakerVirtualizerOn = false;
    }

    public DsClientSettings(Parcel src) {
        readFromParcel(src);
    }

    @Override // android.os.Parcelable
    public void writeToParcel(Parcel dest, int flags) {
        boolean[] settings = {this.isGeqOn, this.isDialogEnhancerOn, this.isVolumeLevellerOn, this.isHeadphoneVirtualizerOn, this.isSpeakerVirtualizerOn};
        dest.writeBooleanArray(settings);
    }

    public void readFromParcel(Parcel src) {
        boolean[] settings = new boolean[5];
        src.readBooleanArray(settings);
        this.isGeqOn = settings[0];
        this.isDialogEnhancerOn = settings[1];
        this.isVolumeLevellerOn = settings[2];
        this.isHeadphoneVirtualizerOn = settings[3];
        this.isSpeakerVirtualizerOn = settings[4];
    }

    public void setGeqOn(boolean enable) {
        this.isGeqOn = enable;
    }

    public boolean getGeqOn() {
        return this.isGeqOn;
    }

    public void setDialogEnhancerOn(boolean enable) {
        this.isDialogEnhancerOn = enable;
    }

    public boolean getDialogEnhancerOn() {
        return this.isDialogEnhancerOn;
    }

    public void setVolumeLevellerOn(boolean enable) {
        this.isVolumeLevellerOn = enable;
    }

    public boolean getVolumeLevellerOn() {
        return this.isVolumeLevellerOn;
    }

    public void setHeadphoneVirtualizerOn(boolean enable) {
        this.isHeadphoneVirtualizerOn = enable;
    }

    public boolean getHeadphoneVirtualizerOn() {
        return this.isHeadphoneVirtualizerOn;
    }

    public void setSpeakerVirtualizerOn(boolean enable) {
        this.isSpeakerVirtualizerOn = enable;
    }

    public boolean getSpeakerVirtualizerOn() {
        return this.isSpeakerVirtualizerOn;
    }
}
