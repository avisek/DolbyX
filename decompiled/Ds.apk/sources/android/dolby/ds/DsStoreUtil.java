package android.dolby.ds;

import android.dolby.DsCommon;
import android.dolby.DsLog;
import android.util.Log;
import android.util.Xml;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserException;
import org.xmlpull.v1.XmlPullParserFactory;
import org.xmlpull.v1.XmlSerializer;

/* JADX INFO: loaded from: classes.dex */
public class DsStoreUtil {
    private static final String ATTRIBUTE_DEV = "dev";
    private static final String ATTRIBUTE_ID = "id";
    private static final String ATTRIBUTE_NAME = "name";
    private static final String ATTRIBUTE_PRESET = "preset";
    private static final int DEFAULT_PROFILE = 0;
    private static String DS_CURRENT_SETTINGS_PATH = null;
    private static String DS_STATE_PATH = null;
    private static final String SUBTAG_CONSTANT = "constant";
    private static final String SUBTAG_DATA = "data";
    private static final String SUBTAG_INCLUDE = "include";
    private static final String SUBTAG_ONOFF = "DsOn";
    private static final String SUBTAG_PRESET = "preset";
    private static final String SUBTAG_PROFILE = "profile";
    private static final String SUBTAG_PROFILEID = "CurrentProfile";
    private static final String SUBTAG_TUNING = "tuning";
    private static final String TAG = "DsStoreUtil";
    private static final String TAG_DS_CURRENT = "currentdata";
    private static final String TAG_DS_STATE = "DsState";

    public static void storeDsPath(String dsCurSettingsPath, String dsStatePath) {
        DS_CURRENT_SETTINGS_PATH = dsCurSettingsPath;
        DS_STATE_PATH = dsStatePath;
    }

    /* JADX WARN: Failed to find 'out' block for switch in B:7:0x002d. Please report as an issue. */
    public static String[] loadDsState() {
        FileInputStream fileis;
        XmlPullParser xpp;
        int eventType;
        String parameterName;
        boolean tagFlag;
        String[] currentState = {"1", Integer.toString(0)};
        try {
            fileis = new FileInputStream(DS_STATE_PATH);
            try {
                XmlPullParserFactory factory = XmlPullParserFactory.newInstance();
                xpp = factory.newPullParser();
                xpp.setInput(fileis, "UTF-8");
                parameterName = null;
                tagFlag = false;
            } catch (XmlPullParserException e) {
                DsLog.log1(TAG, "Erro occurred when parsing " + DS_STATE_PATH + ", using default value.");
            }
        } catch (FileNotFoundException e2) {
            DsLog.log1(TAG, "Cannot find DS state file " + DS_STATE_PATH + ", using default value.");
        }
        for (eventType = xpp.getEventType(); eventType != 1; eventType = xpp.next()) {
            switch (eventType) {
                case 2:
                    tagFlag = true;
                    parameterName = xpp.getName();
                    DsLog.log2(TAG, "Name: " + parameterName);
                    break;
                case 3:
                    tagFlag = false;
                    break;
                case 4:
                    try {
                        String parameterValue = xpp.getText();
                        DsLog.log2(TAG, "Text: " + parameterValue);
                        if (tagFlag) {
                            if (parameterName.equals(SUBTAG_ONOFF)) {
                                currentState[0] = parameterValue;
                            }
                            if (parameterName.equals(SUBTAG_PROFILEID)) {
                                currentState[1] = parameterValue;
                            }
                        }
                    } catch (IOException e3) {
                        DsLog.log1(TAG, "Error occurred when parsing" + DS_STATE_PATH + ", using default value.");
                    }
                    break;
                default:
                    break;
            }
            return currentState;
        }
        fileis.close();
        return currentState;
    }

    public static void saveDsState(String dsState, String currentProfile) {
        try {
            FileOutputStream fileos = new FileOutputStream(DS_STATE_PATH);
            XmlSerializer serializer = Xml.newSerializer();
            try {
                serializer.setOutput(fileos, "utf-8");
                serializer.startDocument(null, null);
                serializer.text("\n");
                serializer.startTag(null, TAG_DS_STATE);
                serializer.text("\n");
                serializer.comment("Ds on/off state");
                serializer.text("\n");
                serializer.startTag(null, SUBTAG_ONOFF);
                serializer.text(dsState);
                serializer.endTag(null, SUBTAG_ONOFF);
                serializer.text("\n");
                serializer.comment("Profile index");
                serializer.text("\n");
                serializer.startTag(null, SUBTAG_PROFILEID);
                serializer.text(currentProfile);
                serializer.endTag(null, SUBTAG_PROFILEID);
                serializer.text("\n");
                serializer.endTag(null, TAG_DS_STATE);
                serializer.endDocument();
                serializer.flush();
                fileos.close();
            } catch (Exception e) {
                Log.e(TAG, "saveDsState(): error occurred while creating xml file");
            }
        } catch (FileNotFoundException e2) {
            Log.e(TAG, "Failed to find or load " + DS_STATE_PATH + ", and the file could not be created");
        }
    }

    private static String[] convertArray(short[][] integerArray) {
        String[] stringArray = new String[integerArray.length];
        int gebfLen = DsAkSettings.getParamArrayLength("gebf");
        for (int i = 0; i < integerArray.length; i++) {
            short[] oneIntegerSetting = integerArray[i];
            String oneStringArray = "gebg=[";
            for (int j = 0; j < gebfLen - 1; j++) {
                oneStringArray = oneStringArray + String.valueOf((int) oneIntegerSetting[j]) + ", ";
            }
            stringArray[i] = oneStringArray + String.valueOf((int) oneIntegerSetting[gebfLen - 1]) + "]";
        }
        return stringArray;
    }

    public static void saveDsProfileSettings(DsProfileSettings[] currentProfiles) {
        String[][] geqName = DsCommon.GEQ_NAMES_XML;
        String[] profileIdName = DsCommon.PROFILE_NAMES_XML;
        try {
            FileOutputStream fileos = new FileOutputStream(DS_CURRENT_SETTINGS_PATH);
            XmlSerializer serializer = Xml.newSerializer();
            try {
                serializer.setOutput(fileos, "utf-8");
                serializer.startDocument(null, null);
                serializer.text("\n");
                serializer.startTag(null, TAG_DS_CURRENT);
                serializer.text("\n\n");
                for (int profile = 0; profile <= 5; profile++) {
                    String DsCurrentSettings = currentProfiles[profile].getCurrentProfileSettings();
                    String DsCurrentProfileNames = currentProfiles[profile].getDisplayName();
                    int DsCurrentIeqPresets = currentProfiles[profile].getIeqPreset();
                    short[][] DsCurrentGeqSettings = currentProfiles[profile].getGeqGainArray();
                    if (DsCurrentGeqSettings != null) {
                        String[] settingStr = convertArray(DsCurrentGeqSettings);
                        serializer.comment("gebg settings for " + profileIdName[profile] + " profile");
                        serializer.text("\n");
                        for (int index = 0; index <= 3; index++) {
                            serializer.startTag(null, "preset");
                            serializer.attribute(null, ATTRIBUTE_ID, geqName[profile][index]);
                            serializer.text("\n    ");
                            serializer.startTag(null, SUBTAG_DATA);
                            serializer.text(settingStr[index]);
                            serializer.endTag(null, SUBTAG_DATA);
                            serializer.text("\n");
                            serializer.endTag(null, "preset");
                            serializer.text("\n");
                        }
                    }
                    if (DsCurrentSettings != null) {
                        serializer.comment("profile settings for " + profileIdName[profile] + " profile");
                        serializer.text("\n");
                        serializer.startTag(null, SUBTAG_PROFILE);
                        serializer.attribute(null, ATTRIBUTE_ID, profileIdName[profile]);
                        serializer.attribute(null, ATTRIBUTE_NAME, DsCurrentProfileNames);
                        serializer.text("\n    ");
                        serializer.startTag(null, SUBTAG_DATA);
                        serializer.text(DsCurrentSettings);
                        serializer.endTag(null, SUBTAG_DATA);
                        serializer.text("\n    ");
                        serializer.startTag(null, SUBTAG_INCLUDE);
                        serializer.attribute(null, "preset", geqName[profile][DsCurrentIeqPresets]);
                        serializer.endTag(null, SUBTAG_INCLUDE);
                        serializer.text("\n");
                        serializer.endTag(null, SUBTAG_PROFILE);
                        serializer.text("\n\n");
                    }
                }
                serializer.endTag(null, TAG_DS_CURRENT);
                serializer.endDocument();
                serializer.flush();
                fileos.close();
            } catch (Exception e) {
                e.printStackTrace();
                Log.e(TAG, "saveDsProfileSettings(): error occurred while saving the current DS profile settings");
            }
        } catch (FileNotFoundException e2) {
            Log.e(TAG, "Failed to find or load " + DS_CURRENT_SETTINGS_PATH + ", and the file could not be created");
        }
    }
}
