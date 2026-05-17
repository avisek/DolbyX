package android.dolby.ds;

import android.dolby.DsClientSettings;
import android.dolby.DsLog;
import android.util.Log;
import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public class DsProfileSettings {
    public static final int DB_SCALING_FACTOR = 16;
    private static final String TAG = "DsProfileSettings";
    private static short[][] ieqBandTargets_ = (short[][]) null;
    private HashMap<AudioDevice, DsAkSettings> allSettings_;
    private Category category_;
    private int currentIeqPreset_;
    private boolean custom_;
    private String description_;
    private String displayName_;
    private short[][] geqBandGains_;
    private HashSet<String> profileParamsToBeSaved_;

    public enum Category {
        MUSIC(0),
        MOVIE(1),
        GAME(2),
        VOICE(3),
        CUSTOMIZED(4);

        public static final int COUNT = 5;
        private int value_;
        private static final String[] NAME = {"Music", "Movie", "Game", "Voice", "Customized"};
        private static final Category[] CATEGORY = {MUSIC, MOVIE, GAME, VOICE, CUSTOMIZED};

        public int toInt() {
            return this.value_;
        }

        @Override // java.lang.Enum
        public String toString() {
            return NAME[this.value_];
        }

        public static Category FromInt(int i) {
            return CATEGORY[i];
        }

        Category(int value) {
            this.value_ = value;
        }
    }

    DsProfileSettings(String displayName, String description, Map<DsEndpoint, DsAkSettings> allSettings, boolean custom, Category category, int ieqPreset, int[][] geqSettings, HashSet<String> savedParams) throws InstantiationException, IllegalArgumentException {
        this.geqBandGains_ = (short[][]) null;
        if (!DsAkSettings.isConstantAkParamsDefined()) {
            throw new InstantiationException("Constant AK parameters NOT defined yet.");
        }
        if (ieqBandTargets_ == null) {
            throw new InstantiationException("IEq settings NOT defined yet.");
        }
        this.displayName_ = displayName;
        this.description_ = description;
        this.custom_ = custom;
        this.category_ = category;
        this.allSettings_ = new HashMap<>();
        for (DsEndpoint endpoint : allSettings.keySet()) {
            this.allSettings_.put(endpoint.toDevice(), allSettings.get(endpoint));
        }
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        int gebgLen = DsAkSettings.getGeqBandCount();
        this.geqBandGains_ = (short[][]) Array.newInstance((Class<?>) Short.TYPE, 4, gebgLen);
        if (geqSettings != null) {
            if (geqSettings.length != 4 || geqSettings[0].length != gebgLen) {
                Log.e(TAG, "Wrong array length for GEq settings, check whether the length conforms to genb in the XML file");
                throw new IllegalArgumentException("GEq settings array length is invalid");
            }
            for (int i = 0; i < 4; i++) {
                for (int j = 0; j < gebgLen; j++) {
                    this.geqBandGains_[i][j] = (short) geqSettings[i][j];
                }
            }
        } else {
            for (int i2 = 0; i2 < 4; i2++) {
                for (int j2 = 0; j2 < gebgLen; j2++) {
                    this.geqBandGains_[i2][j2] = akSettings.get("gebg", j2);
                }
            }
        }
        short ieqOn = akSettings.get("ieon", 0);
        if (ieqOn == 0) {
            ieqPreset = 0;
        } else if (ieqPreset == 0) {
            ieqPreset = 1;
        }
        this.currentIeqPreset_ = ieqPreset;
        for (int i3 = 0; i3 < gebgLen; i3++) {
            this.geqBandGains_[this.currentIeqPreset_][i3] = akSettings.set("gebg", i3, this.geqBandGains_[this.currentIeqPreset_][i3]);
        }
        int iebtLen = DsAkSettings.getParamArrayLength("iebt");
        for (int i4 = 0; i4 < iebtLen; i4++) {
            ieqBandTargets_[this.currentIeqPreset_][i4] = akSettings.set("iebt", i4, ieqBandTargets_[this.currentIeqPreset_][i4]);
        }
        this.profileParamsToBeSaved_ = savedParams;
    }

    Map<AudioDevice, DsAkSettings> getAllSettings() {
        return this.allSettings_;
    }

    public String toString() {
        return this.displayName_;
    }

    public String getDisplayName() {
        return this.displayName_;
    }

    public String getDescription() {
        return this.description_;
    }

    public boolean isCustom() {
        return this.custom_;
    }

    public Category getCategory() {
        return this.category_;
    }

    public short[][] getGeqGainArray() {
        return this.geqBandGains_;
    }

    public String getCurrentProfileSettings() {
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        String settingStr = null;
        if (this.profileParamsToBeSaved_ != null) {
            settingStr = "";
            Iterator<String> it = this.profileParamsToBeSaved_.iterator();
            while (it.hasNext()) {
                String param = it.next();
                short value = akSettings.get(param, 0);
                int len = DsAkSettings.getParamArrayLength(param);
                String settingStr2 = settingStr + param + "=[" + String.valueOf((int) value);
                for (int j = 1; j < len; j++) {
                    short value2 = akSettings.get(param, j);
                    settingStr2 = settingStr2 + ", " + String.valueOf((int) value2);
                }
                if (it.hasNext()) {
                    settingStr = settingStr2 + "] ";
                } else {
                    settingStr = settingStr2 + "]";
                }
            }
        }
        return settingStr;
    }

    public void newFrom(DsProfileSettings source) {
        Map<AudioDevice, DsAkSettings> allSettings = source.getAllSettings();
        this.allSettings_ = new HashMap<>();
        for (AudioDevice ad : allSettings.keySet()) {
            this.allSettings_.put(ad, new DsAkSettings(allSettings.get(ad)));
        }
    }

    public void newFrom(String profileSpec) {
    }

    public void setDisplayName(String displayName) {
        if (isCustom()) {
            this.displayName_ = displayName;
        }
    }

    public void setDescription(String description) {
        if (isCustom()) {
            this.description_ = description;
        }
    }

    public static void setIeqBandTargets(int ieqPreset, int[] values) throws UnsupportedOperationException, IllegalArgumentException {
        if (ieqPreset < 0 || ieqPreset >= 4) {
            throw new IllegalArgumentException("Invalid Intelligent Equalizer preset index!");
        }
        if (!DsAkSettings.isConstantAkParamsDefined()) {
            throw new UnsupportedOperationException("Constant AK parameters NOT defined yet.");
        }
        int iebtLen = DsAkSettings.getParamArrayLength("iebt");
        if (values.length != iebtLen) {
            Log.e(TAG, "Invalid count of IEq values, check whether iebt array length conforms to ienb in the XML file");
            throw new IllegalArgumentException("The count of IEq values NOT equal to the IEq band count");
        }
        if (ieqBandTargets_ == null) {
            ieqBandTargets_ = (short[][]) Array.newInstance((Class<?>) Short.TYPE, 4, iebtLen);
        }
        for (int i = 0; i < iebtLen; i++) {
            ieqBandTargets_[ieqPreset][i] = (short) values[i];
        }
    }

    public DsClientSettings extractClientSettings() {
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        DsClientSettings clientSettings = new DsClientSettings();
        boolean isGeqOn = akSettings.get("geon", 0) != 0;
        clientSettings.setGeqOn(isGeqOn);
        boolean isDialogEnhancerOn = akSettings.get("deon", 0) != 0;
        clientSettings.setDialogEnhancerOn(isDialogEnhancerOn);
        boolean isVolumeLevellerOn = akSettings.get("dvle", 0) != 0;
        clientSettings.setVolumeLevellerOn(isVolumeLevellerOn);
        boolean isHeadphoneVirtualizerOn = akSettings.get("vdhe", 0) != 0;
        clientSettings.setHeadphoneVirtualizerOn(isHeadphoneVirtualizerOn);
        boolean isSpeakerVirtualizerOn = akSettings.get("vspe", 0) != 0;
        clientSettings.setSpeakerVirtualizerOn(isSpeakerVirtualizerOn);
        return clientSettings;
    }

    public ArrayList updateFromClientSettings(DsClientSettings clientSettings) {
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        ArrayList<String> paramsChanged = new ArrayList<>();
        short geqOn = clientSettings.getGeqOn() ? (short) 1 : (short) 0;
        if (geqOn != akSettings.get("geon", 0)) {
            akSettings.set("geon", 0, geqOn);
            paramsChanged.add("geon");
        }
        short dialogEnhancerOn = clientSettings.getDialogEnhancerOn() ? (short) 1 : (short) 0;
        if (dialogEnhancerOn != akSettings.get("deon", 0)) {
            akSettings.set("deon", 0, dialogEnhancerOn);
            paramsChanged.add("deon");
        }
        short volumeLevellerOn = clientSettings.getVolumeLevellerOn() ? (short) 1 : (short) 0;
        if (volumeLevellerOn != akSettings.get("dvle", 0)) {
            akSettings.set("dvle", 0, volumeLevellerOn);
            paramsChanged.add("dvle");
        }
        short headphoneVirtualizerOn = clientSettings.getHeadphoneVirtualizerOn() ? (short) 2 : (short) 0;
        if (headphoneVirtualizerOn != akSettings.get("vdhe", 0)) {
            akSettings.set("vdhe", 0, headphoneVirtualizerOn);
            paramsChanged.add("vdhe");
        }
        short speakerVirtualizerOn = clientSettings.getSpeakerVirtualizerOn() ? (short) 2 : (short) 0;
        if (speakerVirtualizerOn != akSettings.get("vspe", 0)) {
            akSettings.set("vspe", 0, speakerVirtualizerOn);
            paramsChanged.add("vspe");
        }
        return paramsChanged;
    }

    public void setIeqPreset(int preset) {
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        if (preset != this.currentIeqPreset_) {
            akSettings.set("ieon", 0, preset != 0 ? (short) 1 : (short) 0);
            int iebtLen = DsAkSettings.getParamArrayLength("iebt");
            for (int i = 0; i < iebtLen; i++) {
                ieqBandTargets_[preset][i] = akSettings.set("iebt", i, ieqBandTargets_[preset][i]);
            }
            int gebgLen = DsAkSettings.getGeqBandCount();
            for (int i2 = 0; i2 < gebgLen; i2++) {
                this.geqBandGains_[preset][i2] = akSettings.set("gebg", i2, this.geqBandGains_[preset][i2]);
            }
            this.currentIeqPreset_ = preset;
            return;
        }
        DsLog.log2(TAG, "Set the same Ieq value " + preset + " as last time, nothing will be done.");
    }

    public int getIeqPreset() {
        return this.currentIeqPreset_;
    }

    public short[] setGeq(int preset, float[] gains) {
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        int gebfLen = DsAkSettings.getParamArrayLength("gebf");
        short[] values = new short[gebfLen];
        for (int i = 0; i < gebfLen; i++) {
            values[i] = (short) (16.0f * gains[i]);
            values[i] = akSettings.set("gebg", i, values[i]);
            this.geqBandGains_[preset][i] = values[i];
        }
        return values;
    }

    public float[] getGeq(int preset) {
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        int gebfLen = DsAkSettings.getParamArrayLength("gebf");
        float[] values = new float[gebfLen];
        for (int i = 0; i < gebfLen; i++) {
            values[i] = akSettings.get("gebg", i) / 16.0f;
        }
        return values;
    }

    public void setDsApParam(String parameter, short[] values) throws UnsupportedOperationException {
        if (!DsAkSettings.akSettableParamDefinitions.contains(parameter)) {
            Log.e(TAG, "the parameter " + parameter + " is NOT settable.");
            throw new UnsupportedOperationException("Invalid parameter");
        }
        int len = DsAkSettings.getParamArrayLength(parameter);
        if (values.length != len) {
            Log.e(TAG, "the values length " + values.length + " is NOT compatible with the desired length " + len);
            throw new UnsupportedOperationException("Invalid values length");
        }
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        for (int i = 0; i < values.length; i++) {
            values[i] = akSettings.set(parameter, i, values[i]);
        }
    }

    public int[] getDsApParam(String parameter) throws UnsupportedOperationException {
        if (!DsAkSettings.akSettableParamDefinitions.contains(parameter)) {
            Log.e(TAG, "the parameter " + parameter + " is NOT retrievable.");
            throw new UnsupportedOperationException("Invalid parameter");
        }
        DsAkSettings akSettings = this.allSettings_.get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        int[] values = new int[DsAkSettings.getParamArrayLength(parameter)];
        for (int i = 0; i < values.length; i++) {
            values[i] = akSettings.get(parameter, i);
        }
        return values;
    }

    public Object[] getParamsSaved() {
        if (this.profileParamsToBeSaved_ != null) {
            return this.profileParamsToBeSaved_.toArray();
        }
        return null;
    }

    public void addParamSaved(String parameter) {
        if (this.profileParamsToBeSaved_ != null && this.profileParamsToBeSaved_.add(parameter)) {
            DsLog.log1(TAG, "Add a new parameter " + parameter + " to the saved list");
        }
    }

    public void removeParamSaved(String parameter) {
        if (this.profileParamsToBeSaved_ != null && this.profileParamsToBeSaved_.remove(parameter)) {
            DsLog.log1(TAG, "Remove the parameter " + parameter + " from the saved list");
        }
    }
}
