package android.dolby.ds;

import android.dolby.DsCommon;
import android.dolby.DsLog;
import android.dolby.ds.DsProfileSettings;
import android.util.Log;
import java.io.InputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Vector;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public class DsPresetsConfiguration {
    private static final String TAG = "DsPresetsConfiguration";
    private static DsProfileSettings offProfile_;
    private static DsConfigParser xmlParserCurrent;
    private static DsConfigParser xmlParserDefault;
    private static Vector<DsProfileSettings> defaultProfiles = new Vector<>();
    private static Vector<DsProfileSettings> currentProfiles = new Vector<>();
    private static boolean ieqSettingsAdded = false;

    public static boolean xmlConfigParsing(InputStream currentSettings, InputStream defaultSettings, boolean useOffProfileForDsOff) {
        try {
            xmlParserCurrent = new DsConfigParser(currentSettings, useOffProfileForDsOff);
        } catch (IllegalArgumentException e) {
            DsLog.log1(TAG, "The current settings are invalid. The default settings will be used.");
        }
        try {
            xmlParserDefault = new DsConfigParser(defaultSettings, useOffProfileForDsOff);
            return true;
        } catch (IllegalArgumentException e2) {
            Log.e(TAG, "Error in parsing the default settings.");
            return false;
        }
    }

    public static boolean getParserStatusFlag() {
        return xmlParserDefault.getParserStatusFlag();
    }

    static boolean createProfileSettings(boolean useOffProfileForDsOff) {
        try {
            defaultProfiles.clear();
            currentProfiles.clear();
            addNewProfileSettings(DsCommon.PROFILE_NAMES_XML[0], DsProfileSettings.Category.MOVIE);
            addNewProfileSettings(DsCommon.PROFILE_NAMES_XML[1], DsProfileSettings.Category.MUSIC);
            addNewProfileSettings(DsCommon.PROFILE_NAMES_XML[2], DsProfileSettings.Category.GAME);
            addNewProfileSettings(DsCommon.PROFILE_NAMES_XML[3], DsProfileSettings.Category.VOICE);
            addNewProfileSettings(DsCommon.PROFILE_NAMES_XML[4], DsProfileSettings.Category.CUSTOMIZED);
            addNewProfileSettings(DsCommon.PROFILE_NAMES_XML[5], DsProfileSettings.Category.CUSTOMIZED);
            if (useOffProfileForDsOff) {
                addOffProfileSettings();
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, e.toString());
            return false;
        }
    }

    public static DsProfileSettings[] getDefaultSettings() {
        return (DsProfileSettings[]) defaultProfiles.toArray(new DsProfileSettings[defaultProfiles.size()]);
    }

    public static DsProfileSettings[] getCurrentSettings() {
        return (DsProfileSettings[]) currentProfiles.toArray(new DsProfileSettings[currentProfiles.size()]);
    }

    public static DsProfileSettings getOffProfileSettings() {
        return offProfile_;
    }

    private static void addIeqSettings() {
        int[][] ieqSettings = xmlParserDefault.getIeqSettingArray();
        if (ieqSettings != null) {
            int len$ = ieqSettings.length;
            int i$ = 0;
            int ieqIndex = 0;
            while (i$ < len$) {
                int[] settings = ieqSettings[i$];
                DsProfileSettings.setIeqBandTargets(ieqIndex, settings);
                i$++;
                ieqIndex++;
            }
        }
    }

    private static void addNewProfileSettings(String name, DsProfileSettings.Category category) throws UnsupportedOperationException {
        HashSet<String> savedParams;
        int[][] geqSettings;
        int[][] profileSettings;
        String profileName;
        int profileIeq;
        HashMap<DsEndpoint, DsAkSettings> allSettings;
        int[][] profileSettings2 = xmlParserDefault.getSettingArray(name, true);
        String profileName2 = xmlParserDefault.getProfileSettingName(name);
        int profileIeq2 = xmlParserDefault.getProfileSettingIeq(name);
        HashMap<DsEndpoint, DsAkSettings> allSettings2 = new HashMap<>();
        int[][] profileGebg = xmlParserDefault.getGeqSettingArray(name, (int[][]) null);
        if (profileSettings2 != null && DsAkSettings.isConstantAkParamsDefined()) {
            try {
                if (!ieqSettingsAdded) {
                    addIeqSettings();
                    ieqSettingsAdded = true;
                }
                allSettings2.put(DsEndpoint.GENERIC, new DsAkSettings(profileSettings2));
                defaultProfiles.add(new DsProfileSettings(profileName2 != null ? profileName2 : name, "The preset loaded for" + name, allSettings2, true, category, profileIeq2 != -1 ? profileIeq2 : 0, profileGebg, null));
                int[][] currentSettings = xmlParserCurrent.getSettingArray(name, false);
                savedParams = xmlParserCurrent.getSavedParams();
                String currentName = xmlParserCurrent.getProfileSettingName(name);
                int currentIeq = xmlParserCurrent.getProfileSettingIeq(name);
                geqSettings = xmlParserCurrent.getGeqSettingArray(name, profileGebg);
                profileSettings = combineSettings(profileSettings2, currentSettings);
                profileName = resolveName(profileName2, currentName);
                profileIeq = resolveIeqPreset(profileIeq2, currentIeq);
                allSettings = new HashMap<>();
            } catch (Exception e) {
                e = e;
            }
            try {
                allSettings.put(DsEndpoint.GENERIC, new DsAkSettings(profileSettings));
                currentProfiles.add(new DsProfileSettings(profileName != null ? profileName : name, "The current settings loaded for" + name, allSettings, true, category, profileIeq != -1 ? profileIeq : 0, geqSettings, savedParams));
                return;
            } catch (Exception e2) {
                e = e2;
                Log.e(TAG, e.toString());
                throw new UnsupportedOperationException("Exception in creating profile settings");
            }
        }
        Log.e(TAG, "Constant AK parameters NOT defined, or profile settings NULL.");
        throw new UnsupportedOperationException("Settings are NOT ready yet.");
    }

    private static void addOffProfileSettings() throws UnsupportedOperationException {
        int[][] profileSettings = xmlParserDefault.getSettingArray("off", true);
        String profileName = xmlParserDefault.getProfileSettingName("off");
        int profileIeq = xmlParserDefault.getProfileSettingIeq("off");
        if (profileSettings != null && DsAkSettings.isConstantAkParamsDefined()) {
            try {
                HashMap<DsEndpoint, DsAkSettings> allSettings = new HashMap<>();
                allSettings.put(DsEndpoint.GENERIC, new DsAkSettings(profileSettings));
                offProfile_ = new DsProfileSettings(profileName != null ? profileName : "off", "The setting used for switching off Ds effect.", allSettings, false, DsProfileSettings.Category.CUSTOMIZED, profileIeq != -1 ? profileIeq : 0, (int[][]) null, null);
                return;
            } catch (Exception e) {
                Log.e(TAG, e.toString());
                throw new UnsupportedOperationException("Exception in creating off profile settings");
            }
        }
        Log.e(TAG, "Constant AK parameters NOT defined, or profile settings NULL.");
        throw new UnsupportedOperationException("Settings are NOT ready yet.");
    }

    private static int[][] combineSettings(int[][] defaultSettings, int[][] currentSettings) {
        int defaultLength = defaultSettings == null ? 0 : defaultSettings.length;
        int currentLength = currentSettings == null ? 0 : currentSettings.length;
        int settingLength = defaultLength + currentLength;
        if (settingLength == 0) {
            return (int[][]) null;
        }
        int[][] settingArray = new int[settingLength][];
        if (defaultLength != 0) {
            System.arraycopy(defaultSettings, 0, settingArray, 0, defaultLength);
        }
        if (currentLength != 0) {
            System.arraycopy(currentSettings, 0, settingArray, defaultLength, currentLength);
        }
        return settingArray;
    }

    private static String resolveName(String defaultName, String currentName) {
        return currentName != null ? currentName : defaultName;
    }

    private static int resolveIeqPreset(int defaultIeq, int currentIeq) {
        return currentIeq != -1 ? currentIeq : defaultIeq;
    }
}
