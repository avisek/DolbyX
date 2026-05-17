package android.dolby.ds;

import android.dolby.DsClientSettings;
import android.dolby.DsCommon;
import android.dolby.DsLog;
import android.util.Log;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Vector;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserException;
import org.xmlpull.v1.XmlPullParserFactory;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public class DsConfigParser {
    private static final int ASCII_TAB_COMMA = 44;
    private static final int ASCII_TAB_CR = 13;
    private static final int ASCII_TAB_EQUAL = 61;
    private static final int ASCII_TAB_LEFT_BRACKET = 91;
    private static final int ASCII_TAB_LF = 10;
    private static final int ASCII_TAB_RIGHT_BRACKET = 93;
    private static final int ASCII_TAB_SPACE = 32;
    private static final int ERROR_INVALID_PARAM_LEN = 64;
    private static final int ERROR_INVALID_PARAM_NAME = 16;
    private static final int ERROR_INVALID_PARAM_VALUE = 32;
    private static final int ERROR_MISSING_IEQ = 2;
    private static final int ERROR_MISSING_OFF = 4;
    private static final int ERROR_MISSING_PARAM = 8;
    private static final int ERROR_MISSING_PROFILE = 1;
    private static final int ERROR_REDUNDANT_IEQ = 8192;
    private static final int ERROR_REDUNDANT_OFF = 16384;
    private static final int ERROR_REDUNDANT_PROFILE = 4096;
    private static final int NO_ERROR = 0;
    private static final String TAG = "DsConfigParser";
    private static final int TUNING_MAX_OFFSET = 329;
    private int[] defaultGeqBandGain_;
    private String parameterDev;
    private String parameterId;
    private String parameterName;
    private String parameterPreset;
    private String parameterType;
    private String parameterValue;
    private String tagName;
    private static LinkedHashMap<String, Integer> profileDefinitions = new LinkedHashMap<>();
    private static LinkedHashMap<String, Integer> ieqDefinitions = new LinkedHashMap<>();
    private LinkedHashMap<String, Boolean> akParamsFound_ = new LinkedHashMap<>();
    private int parserErrorFlag = 0;
    private HashMap<String, ProfileSettings> mapProfile = new HashMap<>();
    private HashMap<String, EqualizerSettings> mapEqualizer = new HashMap<>();
    private HashMap<String, DeviceSettings> mapDevice = new HashMap<>();

    static {
        for (int i = 0; i < DsCommon.PROFILE_NAMES_XML.length; i++) {
            profileDefinitions.put(DsCommon.PROFILE_NAMES_XML[i], Integer.valueOf(i));
        }
        for (int i2 = 0; i2 < DsCommon.IEQ_PRESET_NAMES_XML.length; i2++) {
            ieqDefinitions.put(DsCommon.IEQ_PRESET_NAMES_XML[i2], Integer.valueOf(i2));
            for (int j = 0; j < DsCommon.PROFILE_NAMES_XML.length; j++) {
                ieqDefinitions.put(DsCommon.GEQ_NAMES_XML[j][i2], Integer.valueOf(i2));
            }
        }
    }

    private class ProfileSettings {
        String device;
        String displayName;
        String ieqId;
        String settingStr;

        private ProfileSettings() {
        }
    }

    private class EqualizerSettings {
        String device;
        String settingStr;

        private EqualizerSettings() {
        }
    }

    private class DeviceSettings {
        String device;
        String settingStr;

        private DeviceSettings() {
        }
    }

    public DsConfigParser(InputStream is, boolean useOffProfileForDsOff) {
        this.tagName = null;
        this.parameterType = null;
        this.parameterId = null;
        this.parameterName = null;
        this.parameterPreset = null;
        this.parameterDev = null;
        this.parameterValue = null;
        try {
            XmlPullParserFactory factory = XmlPullParserFactory.newInstance();
            XmlPullParser xpp = factory.newPullParser();
            xpp.setInput(is, "UTF-8");
            boolean tagFlag = false;
            for (int eventType = xpp.getEventType(); eventType != 1; eventType = xpp.next()) {
                switch (eventType) {
                    case 2:
                        tagFlag = true;
                        this.tagName = xpp.getName();
                        if (this.tagName.equals("preset") || this.tagName.equals("profile") || this.tagName.equals("tuning") || this.tagName.equals("constant")) {
                            int count = xpp.getAttributeCount();
                            this.parameterType = this.tagName;
                            this.parameterId = null;
                            this.parameterName = null;
                            this.parameterDev = null;
                            this.parameterPreset = null;
                            this.parameterValue = null;
                            for (int i = 0; i < count; i++) {
                                String nameAttri = xpp.getAttributeName(i);
                                String valueAttri = xpp.getAttributeValue(i);
                                if (nameAttri.equals("id")) {
                                    this.parameterId = valueAttri;
                                }
                                if (nameAttri.equals("name")) {
                                    this.parameterName = valueAttri;
                                }
                                if (nameAttri.equals("dev")) {
                                    this.parameterDev = valueAttri;
                                }
                            }
                        }
                        if (this.tagName.equals("include")) {
                            this.parameterPreset = xpp.getAttributeValue(0);
                            parseParameters();
                        }
                        break;
                    case 3:
                        tagFlag = false;
                        break;
                    case 4:
                        if (tagFlag) {
                            try {
                                if (this.tagName.equals("data")) {
                                    this.parameterValue = xpp.getText();
                                }
                                if (this.parameterValue != null) {
                                    parseParameters();
                                }
                            } catch (IOException e) {
                                Log.e(TAG, "xmlConfigParsing(): error occurred while parsing xml file");
                                throw new IllegalArgumentException("Invalid ds settings");
                            }
                        }
                        break;
                    default:
                        break;
                }
            }
            checkConfigValidity(useOffProfileForDsOff);
        } catch (XmlPullParserException e2) {
            Log.e(TAG, "xmlConfigParsing(): error occurred while parsing xml file");
            throw new IllegalArgumentException("Invalid ds settings");
        }
    }

    private void parseParameters() {
        EqualizerSettings currentSettings = new EqualizerSettings();
        String preIeq = this.parameterId != null ? this.parameterId.substring(0, 3) : null;
        if ("preset".equals(this.parameterType) && ("ieq".equals(preIeq) || "geq".equals(preIeq))) {
            currentSettings.device = this.parameterDev;
            currentSettings.settingStr = this.parameterValue;
            this.mapEqualizer.put(this.parameterId, currentSettings);
            return;
        }
        ProfileSettings currentProfileSettings = new ProfileSettings();
        if ("profile".equals(this.parameterType) && (DsCommon.PROFILE_NAMES_XML[0].equals(this.parameterId) || DsCommon.PROFILE_NAMES_XML[1].equals(this.parameterId) || DsCommon.PROFILE_NAMES_XML[2].equals(this.parameterId) || DsCommon.PROFILE_NAMES_XML[3].equals(this.parameterId) || DsCommon.PROFILE_NAMES_XML[4].equals(this.parameterId) || DsCommon.PROFILE_NAMES_XML[5].equals(this.parameterId) || "off".equals(this.parameterId))) {
            currentProfileSettings.displayName = this.parameterName;
            currentProfileSettings.ieqId = this.parameterPreset;
            currentProfileSettings.device = this.parameterDev;
            currentProfileSettings.settingStr = this.parameterValue;
            this.mapProfile.put(this.parameterId, currentProfileSettings);
            return;
        }
        DeviceSettings currentDeviceSettings = new DeviceSettings();
        if ("tuning".equals(this.parameterType) || "constant".equals(this.parameterType)) {
            currentDeviceSettings.device = this.parameterDev;
            currentDeviceSettings.settingStr = this.parameterValue;
            this.mapDevice.put(this.parameterType, currentDeviceSettings);
        }
    }

    public boolean getParserStatusFlag() {
        boolean ret = true;
        DsLog.log1(TAG, "The parsing result of the configuration file shows below:");
        if (this.parserErrorFlag == 0) {
            DsLog.log1(TAG, "No errors were found when parsing configuration file.");
        } else {
            if ((this.parserErrorFlag & ERROR_REDUNDANT_PROFILE) != 0) {
                Log.w(TAG, "More profiles were specified in configuration file than expected.");
            }
            if ((this.parserErrorFlag & ERROR_REDUNDANT_IEQ) != 0) {
                Log.w(TAG, "More IEQ presets were specified in configuration file than expected.");
            }
            if ((this.parserErrorFlag & ERROR_REDUNDANT_OFF) != 0) {
                Log.w(TAG, "Off profile was specified in configuration file but is not expected.");
            }
            if ((this.parserErrorFlag & 1) != 0) {
                Log.e(TAG, "Not all expected profiles were specified in configuration file");
                ret = false;
            }
            if ((this.parserErrorFlag & 2) != 0) {
                Log.e(TAG, "Not all expected IEQ presets were specified in configuration file");
                ret = false;
            }
            if ((this.parserErrorFlag & 4) != 0) {
                Log.e(TAG, "Off profile was expected but NOT specified in configuration file");
                ret = false;
            }
            if ((this.parserErrorFlag & 8) != 0) {
                Log.e(TAG, "Some AK parameters were missing in configuration file");
                ret = false;
            }
            if ((this.parserErrorFlag & 16) != 0) {
                Log.e(TAG, "Parameter name parsed from configuration file was not valid or in the required format");
                ret = false;
            }
            if ((this.parserErrorFlag & 32) != 0) {
                Log.e(TAG, "Parameter value parsed from configuration file was not valid or in the required format");
                ret = false;
            }
            if ((this.parserErrorFlag & ERROR_INVALID_PARAM_LEN) != 0) {
                Log.e(TAG, "The length of data specified for the AK parameter is inconsistent with the related AK parameter that determines the expected length.");
                ret = false;
            }
        }
        if (!ret) {
            Log.e(TAG, "Parsing has failed, DS will be disabled! Please correct the errors in configuration file");
        }
        return ret;
    }

    private void checkConfigValidity(boolean useOffProfileForDsOff) {
        int requiredProfileNum = 5;
        for (int i = 0; i <= 5; i++) {
            if (this.mapProfile.get(DsCommon.PROFILE_NAMES_XML[i]) == null) {
                this.parserErrorFlag |= 1;
            }
        }
        for (int i2 = 1; i2 <= 3; i2++) {
            if (this.mapEqualizer.get(DsCommon.IEQ_PRESET_NAMES_XML[i2]) == null) {
                this.parserErrorFlag |= 2;
            }
        }
        if (useOffProfileForDsOff) {
            requiredProfileNum = 5 + 1;
            if (this.mapProfile.get("off") == null) {
                this.parserErrorFlag |= 4;
            }
        } else if (this.mapProfile.get("off") != null) {
            this.parserErrorFlag |= ERROR_REDUNDANT_OFF;
        }
        if (this.mapProfile.size() > requiredProfileNum + 1) {
            this.parserErrorFlag |= ERROR_REDUNDANT_PROFILE;
        }
        if (this.mapEqualizer.size() > 3) {
            this.parserErrorFlag |= ERROR_REDUNDANT_IEQ;
        }
    }

    private int[][] getProfileSettingArray(String profile) {
        new Vector();
        new ProfileSettings();
        ProfileSettings currentProfileSettings = this.mapProfile.get(profile);
        if (currentProfileSettings == null) {
            return (int[][]) null;
        }
        DsLog.log1(TAG, "profile settingStr: " + currentProfileSettings.settingStr);
        Vector<int[]> settingList = parseSettingGroup(currentProfileSettings.settingStr);
        if (settingList == null) {
            return (int[][]) null;
        }
        DsLog.log1(TAG, "profile setting list size: " + settingList.size());
        return (int[][]) settingList.toArray(new int[settingList.size()][]);
    }

    public String getProfileSettingName(String profile) {
        new ProfileSettings();
        ProfileSettings currentProfileSettings = this.mapProfile.get(profile);
        if (currentProfileSettings == null) {
            return null;
        }
        DsLog.log1(TAG, "displayName: " + currentProfileSettings.displayName);
        return currentProfileSettings.displayName;
    }

    public int getProfileSettingIeq(String profile) {
        new ProfileSettings();
        ProfileSettings currentProfileSettings = this.mapProfile.get(profile);
        if (currentProfileSettings == null) {
            return -1;
        }
        DsLog.log1(TAG, "ieqId: " + currentProfileSettings.ieqId);
        Integer index = ieqDefinitions.get(currentProfileSettings.ieqId);
        if (index != null) {
            return index.intValue();
        }
        return -1;
    }

    private int[][] getTuningSettingArray() {
        String settingStr;
        new Vector();
        DeviceSettings deviceTuningSettings = this.mapDevice.get("tuning");
        DeviceSettings deviceConstantSettings = this.mapDevice.get("constant");
        if (deviceTuningSettings == null) {
            settingStr = deviceConstantSettings == null ? null : deviceConstantSettings.settingStr;
        } else {
            settingStr = deviceConstantSettings == null ? deviceTuningSettings.settingStr : deviceTuningSettings.settingStr + deviceConstantSettings.settingStr;
        }
        if (settingStr == null) {
            return (int[][]) null;
        }
        DsLog.log1(TAG, "tuning settingStr: " + settingStr);
        Vector<int[]> settingList = parseSettingGroup(settingStr);
        if (settingList == null) {
            return (int[][]) null;
        }
        DsLog.log1(TAG, "device setting list size: " + settingList.size());
        return (int[][]) settingList.toArray(new int[settingList.size()][]);
    }

    public int[][] getSettingArray(String profile, boolean requireAllParams) {
        Object[] settableParamNames = DsAkSettings.akSettableParamDefinitions.toArray();
        for (Object obj : settableParamNames) {
            this.akParamsFound_.put((String) obj, false);
        }
        int[][] tuningArray = getTuningSettingArray();
        int[][] profileArray = getProfileSettingArray(profile);
        int profileLength = profileArray == null ? 0 : profileArray.length;
        int tuningLength = tuningArray == null ? 0 : tuningArray.length;
        int settingLength = profileLength + tuningLength;
        if (settingLength == 0) {
            return (int[][]) null;
        }
        if (requireAllParams) {
            for (String paramName : this.akParamsFound_.keySet()) {
                if (!this.akParamsFound_.get(paramName).booleanValue() && !paramName.equals("lcmf") && !paramName.equals("iebt")) {
                    Log.e(TAG, "AK parameter " + paramName + " missing in xml file!");
                    this.parserErrorFlag |= 8;
                }
            }
        }
        int[][] settingArray = new int[settingLength][];
        if (profileLength != 0) {
            System.arraycopy(profileArray, 0, settingArray, 0, profileLength);
        }
        if (tuningLength != 0) {
            System.arraycopy(tuningArray, 0, settingArray, profileLength, tuningLength);
        }
        DsLog.log1(TAG, "total setting list size: " + settingArray.length);
        return settingArray;
    }

    public int[][] getIeqSettingArray() {
        int len = DsAkSettings.getParamArrayLength("iebt");
        return equalizerSettingArray(DsCommon.IEQ_PRESET_NAMES_XML, len, (int[][]) null);
    }

    public int[][] getGeqSettingArray(String profile, int[][] defaultGebg) {
        int len = DsAkSettings.getParamArrayLength("gebg");
        return equalizerSettingArray(DsCommon.GEQ_NAMES_XML[profileDefinitions.get(profile).intValue()], len, defaultGebg);
    }

    private int[][] equalizerSettingArray(String[] paramNames, int length, int[][] userDefaultGebg) {
        Vector<int[]> eqList = new Vector<>();
        new EqualizerSettings();
        for (int i = 0; i < 4; i++) {
            EqualizerSettings currentSettings = this.mapEqualizer.get(paramNames[i]);
            if (currentSettings == null) {
                if (paramNames[i].substring(0, 3).equalsIgnoreCase("geq")) {
                    if (userDefaultGebg != null) {
                        eqList.add(userDefaultGebg[i]);
                    } else if (this.defaultGeqBandGain_ != null) {
                        eqList.add(this.defaultGeqBandGain_);
                    } else {
                        eqList.add(new int[length]);
                    }
                } else {
                    eqList.add(new int[length]);
                }
            } else {
                String settingGroup = currentSettings.settingStr;
                int end = 0;
                int arrayLength = settingGroup.length();
                while (true) {
                    if (settingGroup.charAt(end) != ASCII_TAB_LF && settingGroup.charAt(end) != ASCII_TAB_CR && settingGroup.charAt(end) != ' ') {
                        break;
                    }
                    end++;
                }
                int start = end;
                while (end < arrayLength) {
                    boolean isParamFound = false;
                    int spaceCount = 0;
                    while (settingGroup.charAt(end) != ASCII_TAB_EQUAL) {
                        if (settingGroup.charAt(end) == ' ') {
                            spaceCount++;
                        }
                        end++;
                    }
                    String parameter = settingGroup.substring(start, end - spaceCount);
                    if (!parameter.equals("iebt") && !parameter.equals("gebg")) {
                        Log.e(TAG, "Unexpected parameter name " + parameter + " for equalizer settings");
                        this.parserErrorFlag |= 16;
                    } else {
                        isParamFound = true;
                    }
                    while (settingGroup.charAt(end) != ASCII_TAB_LEFT_BRACKET) {
                        end++;
                    }
                    start = end;
                    while (settingGroup.charAt(end) != ASCII_TAB_RIGHT_BRACKET) {
                        end++;
                    }
                    end++;
                    if (isParamFound) {
                        String value = settingGroup.substring(start, end);
                        int[] actualSettings = convertStringArray(value);
                        if (actualSettings != null) {
                            if (!DsAkSettings.isAkParamLengthValid(parameter, actualSettings.length)) {
                                this.parserErrorFlag |= ERROR_INVALID_PARAM_LEN;
                            }
                            eqList.add(actualSettings);
                        } else {
                            Log.e(TAG, "The values for AK parameter " + parameter + " are invalid");
                        }
                    }
                    if (end != arrayLength) {
                        do {
                            if (settingGroup.charAt(end) != ASCII_TAB_LF && settingGroup.charAt(end) != ASCII_TAB_CR && settingGroup.charAt(end) != ' ') {
                                break;
                            }
                            end++;
                        } while (end != arrayLength);
                        start = end;
                    }
                }
            }
        }
        return (int[][]) eqList.toArray(new int[eqList.size()][]);
    }

    private int[] convertStringArray(String valueStr) {
        int end = 1;
        int[] value = new int[TUNING_MAX_OFFSET];
        int count = 0;
        int arrayLength = valueStr.length();
        while (valueStr.charAt(end) == ' ') {
            end++;
        }
        int start = end;
        while (end < arrayLength) {
            int spaceCount = 0;
            while (valueStr.charAt(end) != ASCII_TAB_COMMA && valueStr.charAt(end) != ASCII_TAB_RIGHT_BRACKET) {
                if (valueStr.charAt(end) == ' ') {
                    spaceCount++;
                }
                end++;
            }
            try {
                value[count] = Integer.parseInt(valueStr.substring(start, end - spaceCount));
                count++;
                end++;
                if (end != arrayLength) {
                    while (valueStr.charAt(end) == ' ') {
                        end++;
                    }
                    start = end;
                }
            } catch (Exception e) {
                this.parserErrorFlag |= 32;
                return null;
            }
        }
        int[] settingValue = new int[count];
        System.arraycopy(value, 0, settingValue, 0, count);
        return settingValue;
    }

    private Vector<int[]> parseSettingGroup(String settingGroup) {
        if (settingGroup == null) {
            return null;
        }
        Vector<int[]> settingList = new Vector<>();
        int parameter = 0;
        int end = 0;
        int arrayLength = settingGroup.length();
        while (true) {
            if (settingGroup.charAt(end) != ASCII_TAB_LF && settingGroup.charAt(end) != ASCII_TAB_CR && settingGroup.charAt(end) != ' ') {
                break;
            }
            end++;
        }
        int start = end;
        while (end < arrayLength) {
            boolean isParamFound = false;
            int spaceCount = 0;
            while (settingGroup.charAt(end) != ASCII_TAB_EQUAL) {
                if (settingGroup.charAt(end) == ' ') {
                    spaceCount++;
                }
                end++;
            }
            String paraName = settingGroup.substring(start, end - spaceCount);
            if (DsAkSettings.akSettableParamDefinitions.contains(paraName)) {
                parameter = DsAkSettings.getAkParamIndex(paraName);
                this.akParamsFound_.put(paraName, true);
                isParamFound = true;
            } else {
                Log.e(TAG, "Unexpected AK parameter name " + paraName);
                this.parserErrorFlag |= 16;
            }
            while (settingGroup.charAt(end) != ASCII_TAB_LEFT_BRACKET) {
                end++;
            }
            start = end;
            while (settingGroup.charAt(end) != ASCII_TAB_RIGHT_BRACKET) {
                end++;
            }
            end++;
            if (isParamFound) {
                String paraValue = settingGroup.substring(start, end);
                int[] actualSettings = convertStringArray(paraValue);
                if (actualSettings != null) {
                    if (!DsAkSettings.isConstantAkParamsDefined() && (paraName.equalsIgnoreCase("genb") || paraName.equalsIgnoreCase("aonb") || paraName.equalsIgnoreCase("ienb") || paraName.equalsIgnoreCase("gebf"))) {
                        DsAkSettings.setConstantAkParam(paraName, actualSettings);
                    } else if (!DsAkSettings.isAkParamLengthValid(paraName, actualSettings.length)) {
                        this.parserErrorFlag |= ERROR_INVALID_PARAM_LEN;
                    }
                    for (int i = 0; i < actualSettings.length; i++) {
                        settingList.add(new int[]{parameter, i, actualSettings[i]});
                    }
                    if (paraName.equalsIgnoreCase("gebg")) {
                        this.defaultGeqBandGain_ = actualSettings;
                    }
                } else {
                    Log.e(TAG, "The values for AK parameter " + paraName + " are invalid");
                }
            }
            if (end != arrayLength) {
                do {
                    if (settingGroup.charAt(end) != ASCII_TAB_LF && settingGroup.charAt(end) != ASCII_TAB_CR && settingGroup.charAt(end) != ' ') {
                        break;
                    }
                    end++;
                } while (end != arrayLength);
                start = end;
            }
        }
        return settingList;
    }

    public HashSet<String> getSavedParams() {
        HashSet<String> savedParams = new HashSet<>(DsClientSettings.basicProfileParams);
        for (String paramName : this.akParamsFound_.keySet()) {
            if (this.akParamsFound_.get(paramName).booleanValue() && !paramName.equals("gebg")) {
                savedParams.add(paramName);
            }
        }
        return savedParams;
    }
}
