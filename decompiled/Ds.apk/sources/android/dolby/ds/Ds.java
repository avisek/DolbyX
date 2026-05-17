package android.dolby.ds;

import android.dolby.DsClientSettings;
import android.dolby.DsLog;
import android.dolby.ds.DsProfileSettings;
import android.os.DeadObjectException;
import android.util.Log;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;

/* JADX INFO: loaded from: classes.dex */
public class Ds {
    public static final String DS_CURRENT_FILENAME = "ds1-current.xml";
    public static final String DS_STATE_FILENAME = "ds1-state.xml";
    private static final String DS_VERSION_EXTERNAL = "DS version 1.8.0.0";
    private static final String DS_VERSION_INTERNAL = "DS version 1.8.0.0 [Build 5]";
    private static final int LPA_INVALID_SESSION_ID = -2;
    private static final String TAG = "Ds";
    private static final boolean useOffProfileForDsOff = false;
    private int audioSessionId_;
    private DsProfileSettings[] currentProfiles_;
    private DsProfileSettings[] defaultProfiles_;
    private DsEffect dsEffect_;
    private DsProfileSettings offProfile_;
    private int selectedProfile_ = 0;
    private boolean isDsOn_ = true;
    private int lpaAudioSessionId_ = -2;
    private DsEffect dsLpaEffect_ = null;

    public Ds(int audioSessionId) throws IllegalStateException, IllegalAccessException, NoSuchMethodException, InstantiationException, ClassNotFoundException, InvocationTargetException {
        this.currentProfiles_ = new DsProfileSettings[6];
        this.defaultProfiles_ = new DsProfileSettings[6];
        this.dsEffect_ = null;
        Log.i(TAG, "Creating Ds effect on audioSessionId = " + audioSessionId);
        if (audioSessionId < 0) {
            Log.e(TAG, "Ds effect with specified session Id (" + audioSessionId + ") is less than zero");
            return;
        }
        this.defaultProfiles_ = DsPresetsConfiguration.getDefaultSettings();
        this.currentProfiles_ = DsPresetsConfiguration.getCurrentSettings();
        if (DsAkSettings.isConstantAkParamsDefined()) {
            this.audioSessionId_ = audioSessionId;
            this.dsEffect_ = new DsEffect(this.audioSessionId_);
            setInitStatus(false);
            return;
        }
        throw new InstantiationException("Constant AK parameters NOT defined yet.");
    }

    public void createDsLpaEffect(int lpaAudioSessionId) {
        Log.i(TAG, "Creating DsLpa effect on audioSessionId = " + lpaAudioSessionId);
        try {
            if (lpaAudioSessionId != this.lpaAudioSessionId_) {
                destroyDsLpaEffect();
                this.dsLpaEffect_ = new DsEffect(lpaAudioSessionId);
                this.lpaAudioSessionId_ = lpaAudioSessionId;
                setInitStatus(true);
            }
        } catch (ClassNotFoundException e) {
            this.lpaAudioSessionId_ = -2;
            Log.e(TAG, "createDsLpaEffect() FAILED! ClassNotFoundException");
        } catch (IllegalAccessException e2) {
            this.lpaAudioSessionId_ = -2;
            Log.e(TAG, "createDsLpaEffect() FAILED! IllegalAccessException");
        } catch (IllegalStateException e3) {
            this.lpaAudioSessionId_ = -2;
            Log.e(TAG, "createDsLpaEffect() FAILED! IllegalStateException");
        } catch (InstantiationException e4) {
            this.lpaAudioSessionId_ = -2;
            Log.e(TAG, "createDsLpaEffect() FAILED! InstantiationException");
        } catch (NoSuchMethodException e5) {
            this.lpaAudioSessionId_ = -2;
            Log.e(TAG, "createDsLpaEffect() FAILED! NoSuchMethodException");
        } catch (InvocationTargetException e6) {
            this.lpaAudioSessionId_ = -2;
            Log.e(TAG, "createDsLpaEffect() FAILED! InvocationTargetException");
        } catch (Exception ex) {
            this.lpaAudioSessionId_ = -2;
            Log.e(TAG, "createDsLpaEffect() FAILED! Exception");
            ex.printStackTrace();
        }
    }

    public void destroyDsLpaEffect() {
        if (this.dsLpaEffect_ != null) {
            this.dsLpaEffect_.release();
            this.dsLpaEffect_ = null;
            this.lpaAudioSessionId_ = -2;
        }
    }

    public boolean isLpaActive() {
        return this.lpaAudioSessionId_ != -2;
    }

    public int getLpaAudioSessionId() {
        return this.lpaAudioSessionId_;
    }

    public static boolean populateSettings(InputStream defaultInStream, String dir) {
        boolean ret;
        DsLog.log2(TAG, "populateSettings");
        String dsCurSettingsPath = dir + "/" + DS_CURRENT_FILENAME;
        String dsStatePath = dir + "/" + DS_STATE_FILENAME;
        DsStoreUtil.storeDsPath(dsCurSettingsPath, dsStatePath);
        try {
            FileInputStream currentInStream = new FileInputStream(dsCurSettingsPath);
            ret = DsPresetsConfiguration.xmlConfigParsing(currentInStream, defaultInStream, false);
            currentInStream.close();
            defaultInStream.close();
        } catch (FileNotFoundException e) {
            Log.e(TAG, "Cannot find DS config XML file " + dsCurSettingsPath);
            e.printStackTrace();
            ret = false;
        } catch (Exception e2) {
            Log.e(TAG, "populateSettings(): Exception loading " + dsCurSettingsPath + " or parsing the file");
            e2.printStackTrace();
            ret = false;
        }
        if (ret) {
            boolean ret2 = DsPresetsConfiguration.createProfileSettings(false);
            if (ret2) {
                boolean ret3 = DsPresetsConfiguration.getParserStatusFlag();
                return ret3;
            }
            return ret2;
        }
        return ret;
    }

    public void restoreCurrentProfiles() {
        DsLog.log1(TAG, "Ds resetCurrentProfiles");
        this.currentProfiles_ = DsPresetsConfiguration.getCurrentSettings();
        DsLog.log1(TAG, "current profile settings " + this.currentProfiles_[this.selectedProfile_].getCurrentProfileSettings());
        setInitStatus(false);
    }

    public void saveDsStateAndSettings() {
        DsLog.log2(TAG, "saveDsStateAndSettings");
        DsStoreUtil.saveDsState(this.isDsOn_ ? "1" : "0", String.valueOf(this.selectedProfile_));
        DsStoreUtil.saveDsProfileSettings(this.currentProfiles_);
    }

    public void setDsOn(boolean on) throws DeadObjectException {
        DsLog.log2(TAG, "setDsOn: \"" + on + "\"");
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        this.isDsOn_ = on;
        DsLog.log1(TAG, "Ds on/off setEnabled(" + on + ")");
        this.dsEffect_.setEnabled(on);
        if (isLpaActive()) {
            this.dsLpaEffect_.setEnabled(on);
        }
    }

    public boolean getDsOn() throws DeadObjectException {
        DsLog.log2(TAG, "getDsOn");
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        boolean effectEnabled = this.dsEffect_.getEnabled();
        return effectEnabled;
    }

    public int getProfileCount() {
        DsLog.log2(TAG, "getProfileCount");
        return 6;
    }

    public String[] getProfileNames() {
        String[] profileNames = new String[6];
        DsLog.log2(TAG, "getProfileNames");
        for (int i = 0; i < 6; i++) {
            profileNames[i] = this.currentProfiles_[i].getDisplayName();
        }
        return profileNames;
    }

    public boolean setSelectedProfile(int profile) throws IllegalArgumentException, DeadObjectException {
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        if (profile >= 0 && profile < 6) {
            DsLog.log2(TAG, "setSelectedProfile: \"" + this.currentProfiles_[profile].getDisplayName() + "\"");
            int iRet = this.dsEffect_.setAllProfileSettings(this.currentProfiles_[profile]);
            if (isLpaActive()) {
                iRet |= this.dsLpaEffect_.setAllProfileSettings(this.currentProfiles_[profile]);
            }
            if (iRet != 0) {
                return false;
            }
            this.selectedProfile_ = profile;
            return true;
        }
        Log.e(TAG, "setSelectedProfile: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public int getSelectedProfile() {
        DsLog.log2(TAG, "getSelectedProfile");
        return this.selectedProfile_;
    }

    public boolean setProfileSettings(int profile, DsClientSettings clientSettings) throws IllegalArgumentException, DeadObjectException {
        int paramIndex;
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        DsLog.log2(TAG, "setProfileSettings: \"" + this.currentProfiles_[profile].getDisplayName() + "\"");
        if (profile >= 0 && profile < 6) {
            int iRet = 0;
            ArrayList<String> paramsChanged = this.currentProfiles_[profile].updateFromClientSettings(clientSettings);
            DsAkSettings akSettings = this.currentProfiles_[profile].getAllSettings().get(AudioDevice.DEVICE_WIRED_HEADPHONE);
            for (String param : paramsChanged) {
                int len = DsAkSettings.getParamArrayLength(param);
                short[] values = new short[len];
                for (int i = 0; i < len; i++) {
                    values[i] = akSettings.get(param, i);
                }
                DsLog.log1(TAG, "Updating parameter " + param + " with new value/values");
                if (this.selectedProfile_ == profile && ((iRet = this.dsEffect_.setSingleSetting((paramIndex = DsAkSettings.getAkParamIndex(param)), 0, values, AudioDevice.DEVICE_WIRED_HEADPHONE)) != 0 || (isLpaActive() && (iRet = this.dsLpaEffect_.setSingleSetting(paramIndex, 0, values, AudioDevice.DEVICE_WIRED_HEADPHONE)) != 0))) {
                    break;
                }
            }
            if (iRet != 0) {
                return false;
            }
            return true;
        }
        Log.e(TAG, "setProfileSettings: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public DsClientSettings getProfileSettings(int profile) throws IllegalArgumentException {
        DsLog.log2(TAG, "getProfileSettings: \"" + this.currentProfiles_[profile].getDisplayName() + "\"");
        if (profile >= 0 && profile < 6) {
            return this.currentProfiles_[profile].extractClientSettings();
        }
        Log.e(TAG, "getProfileSettings: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public boolean resetProfile(int profile) throws UnsupportedOperationException, IllegalArgumentException, DeadObjectException {
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        DsLog.log2(TAG, "resetProfile: \"" + this.currentProfiles_[profile].getDisplayName() + "\"");
        if (profile >= 0 && profile < 6) {
            String displayName = this.defaultProfiles_[profile].getDisplayName();
            String description = this.defaultProfiles_[profile].getDescription();
            DsAkSettings akSettings = this.defaultProfiles_[profile].getAllSettings().get(AudioDevice.DEVICE_WIRED_HEADPHONE);
            HashMap<DsEndpoint, DsAkSettings> allSettings = new HashMap<>();
            allSettings.put(DsEndpoint.GENERIC, new DsAkSettings(akSettings));
            boolean custom = this.defaultProfiles_[profile].isCustom();
            DsProfileSettings.Category category = this.defaultProfiles_[profile].getCategory();
            int ieqPreset = this.defaultProfiles_[profile].getIeqPreset();
            try {
                HashSet<String> savedParams = new HashSet<>(DsClientSettings.basicProfileParams);
                this.currentProfiles_[profile] = new DsProfileSettings(displayName, description, allSettings, custom, category, ieqPreset, (int[][]) null, savedParams);
                if (profile == this.selectedProfile_) {
                    this.dsEffect_.setAllProfileSettings(this.currentProfiles_[profile]);
                    if (isLpaActive()) {
                        this.dsLpaEffect_.setAllProfileSettings(this.currentProfiles_[profile]);
                        return true;
                    }
                    return true;
                }
                return true;
            } catch (Exception e) {
                Log.e(TAG, e.toString());
                throw new UnsupportedOperationException();
            }
        }
        Log.e(TAG, "resetProfile: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public boolean setProfileName(int profile, String name) throws UnsupportedOperationException, IllegalArgumentException {
        DsLog.log2(TAG, "setProfileNames: \"" + this.currentProfiles_[profile].getDisplayName() + "\"");
        if (name == null) {
            return false;
        }
        if (profile >= 0 && profile < 6) {
            if (profile >= 4) {
                this.currentProfiles_[profile].setDisplayName(name);
                return true;
            }
            DsLog.log1(TAG, "setProfileName: Name of this Profile is not settable");
            throw new UnsupportedOperationException();
        }
        Log.e(TAG, "setProfileName: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public int setVisualizerOn(boolean enable) throws DeadObjectException {
        DsLog.log2(TAG, "setVisualizerOn: \"" + enable + "\"");
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        return this.dsEffect_.setVisualizerOn(enable);
    }

    public boolean getVisualizerOn() throws DeadObjectException {
        DsLog.log2(TAG, "getVisualizerOn");
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        return this.dsEffect_.getVisualizerOn();
    }

    public int getVisualizerData(float[] gains, float[] excitations) throws DeadObjectException {
        DsLog.log2(TAG, "getVisualizerData");
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        short[] visualizerData = this.dsEffect_.getVisualizerData();
        if (visualizerData == null) {
            return 0;
        }
        int maxLen = DsAkSettings.getParamArrayLength("vcbg");
        int numGains = gains.length < maxLen ? gains.length : maxLen;
        for (int i = 0; i < numGains; i++) {
            gains[i] = visualizerData[i] / 16.0f;
        }
        int numExcitations = excitations.length < maxLen ? excitations.length : maxLen;
        for (int i2 = 0; i2 < numExcitations; i2++) {
            int index = i2 + maxLen;
            excitations[i2] = visualizerData[index] / 16.0f;
        }
        return numGains + numExcitations;
    }

    public String getDsApVersion() throws DeadObjectException {
        DsLog.log2(TAG, "getDsApVersion");
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        short[] value = this.dsEffect_.getVersion();
        StringBuilder version = new StringBuilder("APPv1 version ");
        for (int i = 0; i < value.length - 1; i++) {
            version.append((int) value[i]);
            version.append(".");
        }
        version.append((int) value[value.length - 1]);
        return version.toString();
    }

    public String getDsVersion() {
        DsLog.log2(TAG, "getDsVersion");
        return "DS version 1.8.0.0";
    }

    public boolean setIeqPreset(int profile, int preset) throws IllegalArgumentException, DeadObjectException {
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        DsLog.log2(TAG, "setIeqPreset: \"" + preset + "\"");
        if (profile < 0 || profile >= 6) {
            return false;
        }
        if (preset >= 0 && preset < 4) {
            this.currentProfiles_[profile].setIeqPreset(preset);
            int iRet = this.dsEffect_.setAllProfileSettings(this.currentProfiles_[profile]);
            if (isLpaActive()) {
                iRet |= this.dsLpaEffect_.setAllProfileSettings(this.currentProfiles_[profile]);
            }
            if (iRet != 0) {
                return false;
            }
            return true;
        }
        Log.e(TAG, "setIeqPreset: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public int getIeqPreset(int profile) throws IllegalArgumentException {
        DsLog.log2(TAG, "getIeqPreset");
        if (profile >= 0 && profile < 6) {
            int ret = this.currentProfiles_[profile].getIeqPreset();
            return ret;
        }
        Log.e(TAG, "getIeqPrest: Invalid profile");
        throw new IllegalArgumentException();
    }

    public int getProfileModified(int profile) {
        DsLog.log1(TAG, "getProfileModified");
        int modifiedValue = 0;
        String defaultName = this.defaultProfiles_[profile].getDisplayName();
        String currentName = this.currentProfiles_[profile].getDisplayName();
        if (!defaultName.equals(currentName)) {
            modifiedValue = 0 | 2;
        }
        DsAkSettings akDefaultSettings = this.defaultProfiles_[profile].getAllSettings().get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        DsAkSettings akCurrentSettings = this.currentProfiles_[profile].getAllSettings().get(AudioDevice.DEVICE_WIRED_HEADPHONE);
        Object[] params = this.currentProfiles_[profile].getParamsSaved();
        if (params != null) {
            for (Object obj : params) {
                String param = (String) obj;
                int paramLen = DsAkSettings.getParamArrayLength(param);
                int j = 0;
                while (true) {
                    if (j >= paramLen) {
                        break;
                    }
                    if (akCurrentSettings.get(param, j) == akDefaultSettings.get(param, j)) {
                        j++;
                    } else {
                        modifiedValue |= 1;
                        break;
                    }
                }
            }
        }
        if ((modifiedValue & 1) != 1) {
            int ieqDefaultIndex = this.defaultProfiles_[profile].getIeqPreset();
            int ieqCurrentIndex = this.currentProfiles_[profile].getIeqPreset();
            if (ieqCurrentIndex != ieqDefaultIndex) {
                modifiedValue |= 1;
            }
        }
        if ((modifiedValue & 1) != 1) {
            short[][] geqDefaultSettings = this.defaultProfiles_[profile].getGeqGainArray();
            short[][] geqCurrentSettings = this.currentProfiles_[profile].getGeqGainArray();
            int gebfLen = DsAkSettings.getParamArrayLength("gebf");
            for (int i = 0; i < 4; i++) {
                int j2 = 0;
                while (true) {
                    if (j2 >= gebfLen) {
                        break;
                    }
                    if (geqCurrentSettings[i][j2] == geqDefaultSettings[i][j2]) {
                        j2++;
                    } else {
                        modifiedValue |= 1;
                        break;
                    }
                }
            }
        }
        return modifiedValue;
    }

    public boolean isBasicProfileSettings(String parameter) {
        return DsClientSettings.basicProfileParams.contains(parameter);
    }

    public boolean setGeq(int profile, int preset, float[] geqBandGains) throws IllegalArgumentException, DeadObjectException {
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        DsLog.log2(TAG, "setGeq: \"profile name = " + this.currentProfiles_[profile].getDisplayName() + " preset " + preset + "\"");
        if (profile >= 0 && profile < 6) {
            if (preset >= 0 && preset < 4) {
                int iRet = 0;
                short[] values = this.currentProfiles_[profile].setGeq(preset, geqBandGains);
                if (this.selectedProfile_ == profile) {
                    int paramIndex = DsAkSettings.getAkParamIndex("gebg");
                    iRet = this.dsEffect_.setSingleSetting(paramIndex, 0, values, AudioDevice.DEVICE_WIRED_HEADPHONE);
                    if (isLpaActive()) {
                        iRet |= this.dsLpaEffect_.setSingleSetting(paramIndex, 0, values, AudioDevice.DEVICE_WIRED_HEADPHONE);
                    }
                }
                if (iRet != 0) {
                    return false;
                }
                return true;
            }
            Log.e(TAG, "setGeq: Invalid Ieq preset input");
            throw new IllegalArgumentException();
        }
        Log.e(TAG, "setGeq: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public float[] getGeq(int profile, int preset) throws IllegalArgumentException {
        DsLog.log2(TAG, "getGeq: \"profile name = " + this.currentProfiles_[profile].getDisplayName() + " preset " + preset + "\"");
        if (profile >= 0 && profile < 6) {
            if (preset >= 0 && preset < 4) {
                float[] values = this.currentProfiles_[profile].getGeq(preset);
                return values;
            }
            Log.e(TAG, "getGeq: Invalid preset input");
            throw new IllegalArgumentException();
        }
        Log.e(TAG, "getGeq: Invalid profile input");
        throw new IllegalArgumentException();
    }

    public boolean setDsApParam(String parameter, int[] values) throws UnsupportedOperationException, DeadObjectException {
        boolean ret = false;
        DsLog.log2(TAG, "setDsApParam");
        if (!validateDsEffect()) {
            throw new DeadObjectException();
        }
        if (parameter.equals("iebt")) {
            Log.e(TAG, "iebt is NOT allowed to be set");
            throw new UnsupportedOperationException("Fail to set the parameter");
        }
        if (parameter.equals("gebg")) {
            Log.e(TAG, "gebg is NOT allowed to be set by setDsApParam, please use setGeq instead");
            throw new UnsupportedOperationException("Fail to set the parameter");
        }
        short[] settings = new short[values.length];
        for (int i = 0; i < values.length; i++) {
            settings[i] = (short) values[i];
        }
        try {
            this.currentProfiles_[this.selectedProfile_].setDsApParam(parameter, settings);
            int paramIndex = DsAkSettings.getAkParamIndex(parameter);
            int iRet = this.dsEffect_.setSingleSetting(paramIndex, 0, settings, AudioDevice.DEVICE_WIRED_HEADPHONE);
            if (isLpaActive()) {
                iRet |= this.dsLpaEffect_.setSingleSetting(paramIndex, 0, settings, AudioDevice.DEVICE_WIRED_HEADPHONE);
            }
            if (iRet == 0) {
                ret = true;
            }
            if (!isBasicProfileSettings(parameter)) {
                boolean paramModified = false;
                DsAkSettings defaultSettings = this.defaultProfiles_[this.selectedProfile_].getAllSettings().get(AudioDevice.DEVICE_WIRED_HEADPHONE);
                int i2 = 0;
                while (true) {
                    if (i2 >= settings.length) {
                        break;
                    }
                    if (settings[i2] == defaultSettings.get(parameter, i2)) {
                        i2++;
                    } else {
                        paramModified = true;
                        break;
                    }
                }
                if (paramModified) {
                    this.currentProfiles_[this.selectedProfile_].addParamSaved(parameter);
                } else {
                    this.currentProfiles_[this.selectedProfile_].removeParamSaved(parameter);
                }
            }
            return ret;
        } catch (Exception e) {
            Log.e(TAG, e.toString());
            e.printStackTrace();
            throw new UnsupportedOperationException("Fail to set the parameter");
        }
    }

    public int[] getDsApParam(String parameter) {
        DsLog.log2(TAG, "getDsApParam");
        try {
            int[] values = this.currentProfiles_[this.selectedProfile_].getDsApParam(parameter);
            return values;
        } catch (Exception e) {
            Log.e(TAG, e.toString());
            e.printStackTrace();
            return null;
        }
    }

    public int getDsApParamLength(String parameter) {
        return DsAkSettings.getParamArrayLength(parameter);
    }

    private boolean recreateDsEffect() {
        DsLog.log1(TAG, "recreateDsEffect");
        try {
            if (this.dsEffect_ != null) {
                this.dsEffect_.release();
            }
            this.dsEffect_ = new DsEffect(this.audioSessionId_);
            if (isLpaActive()) {
                int lpaAudioSessionId = this.lpaAudioSessionId_;
                destroyDsLpaEffect();
                createDsLpaEffect(lpaAudioSessionId);
            }
            setInitStatus(true);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Exception in recreateDsEffect.");
            e.printStackTrace();
            return false;
        }
    }

    private void setInitStatus(boolean useExistingState) {
        if (!useExistingState) {
            String[] restoredState = DsStoreUtil.loadDsState();
            this.isDsOn_ = restoredState[0].equals("1");
            this.selectedProfile_ = Integer.parseInt(restoredState[1]);
        }
        DsLog.log1(TAG, "restore Ds=" + this.isDsOn_);
        DsLog.log1(TAG, "restore profile=" + this.selectedProfile_);
        try {
            this.dsEffect_.setEnabled(true);
            if (isLpaActive()) {
                this.dsLpaEffect_.setEnabled(true);
            }
            setSelectedProfile(this.selectedProfile_);
            setDsOn(this.isDsOn_);
        } catch (Exception e) {
            Log.e(TAG, "Exception in setInitStatus");
            e.printStackTrace();
        }
    }

    public boolean validateDsEffect() {
        boolean ret = this.dsEffect_.hasControl() || (this.dsLpaEffect_ != null && this.dsLpaEffect_.hasControl());
        if (!ret) {
            Log.e(TAG, "Cannot control the DsEffect, trying to recreate...");
            return recreateDsEffect();
        }
        return ret;
    }
}
