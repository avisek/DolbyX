package android.dolby.ds;

import android.dolby.DsLog;
import android.util.Log;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;

/* JADX INFO: loaded from: classes.dex */
public class DsAkSettings {
    private static final short AKPARAM_AOCC = 2;
    public static final short AK_DS1_FEATURE_AUTO = 2;
    public static final short AK_DS1_FEATURE_OFF = 0;
    public static final short AK_DS1_FEATURE_ON = 1;
    private static final String LOG_TAG = "DsAkSettings";
    private static short[] settingsDefaults_;
    private short[] values_;
    private static final ParameterDefn[] akParams_ = {new ParameterDefn("bver", 5, -32768, 32767), new ParameterDefn("bndl", 2, -32768, 32767), new ParameterDefn("ocf", 1, 0, 5), new ParameterDefn("preg", 1, -2080, 480), new ParameterDefn("vdhe", 1, 0, 2), new ParameterDefn("vspe", 1, 0, 2), new ParameterDefn("dssf", 1, 20, 20000), new ParameterDefn("dvli", 1, -640, 0), new ParameterDefn("dvlo", 1, -640, 0), new ParameterDefn("dvle", 1, 0, 1), new ParameterDefn("dvmc", 1, -320, 320), new ParameterDefn("dvme", 1, 0, 1), new ParameterDefn("ienb", 1, 1, 40), new ParameterDefn("iebf", 20, 20, 20000), new ParameterDefn("ieon", 1, 0, 1), new ParameterDefn("deon", 1, 0, 1), new ParameterDefn("ngon", 1, 0, 2), new ParameterDefn("geon", 1, 0, 1), new ParameterDefn("genb", 1, 1, 40), new ParameterDefn("gebf", 20, 20, 20000), new ParameterDefn("aonb", 1, 1, 40), new ParameterDefn("aobf", 40, 20, 20000), new ParameterDefn("aobg", 329, -480, 480), new ParameterDefn("aoon", 1, 0, 2), new ParameterDefn("arnb", 1, 1, 40), new ParameterDefn("arbf", 40, 20, 20000), new ParameterDefn("plb", 1, 0, 288), new ParameterDefn("plmd", 1, 0, 4), new ParameterDefn("ven", 1, 0, 1), new ParameterDefn("vnnb", 1, 1, 20), new ParameterDefn("vnbf", 20, -32768, 32767), new ParameterDefn("vnbg", 20, -32768, 32767), new ParameterDefn("vnbe", 20, -32768, 32767), new ParameterDefn("vcnb", 1, 1, 40), new ParameterDefn("vcbf", 20, 20, 20000), new ParameterDefn("vcbg", 20, -192, 576), new ParameterDefn("vcbe", 20, -192, 576), new ParameterDefn("ver", 4, -32768, 32767), new ParameterDefn("pstg", 1, -2080, 480), new ParameterDefn("dhsb", 1, 0, 96), new ParameterDefn("dhrg", 1, -2080, 96), new ParameterDefn("dssb", 1, 0, 96), new ParameterDefn("dssa", 1, 5, 30), new ParameterDefn("dvla", 1, 0, 10), new ParameterDefn("iebt", 20, -480, 480), new ParameterDefn("iea", 1, 0, 16), new ParameterDefn("dea", 1, 0, 16), new ParameterDefn("ded", 1, 0, 16), new ParameterDefn("gebg", 20, -576, 576), new ParameterDefn("aocc", 1, 0, 8), new ParameterDefn("arbi", 40, 0, 1), new ParameterDefn("arbl", 40, -2080, 0), new ParameterDefn("arbh", 40, -2080, 0), new ParameterDefn("arod", 1, 0, 192), new ParameterDefn("artp", 1, 0, 16), new ParameterDefn("endp", 1, 0, 6), new ParameterDefn("mxou", 1, 1, 8), new ParameterDefn("vol", 1, -2048, 480), new ParameterDefn("vmon", 1, 0, 2), new ParameterDefn("vmb", 1, 0, 240), new ParameterDefn("lcmf", 2, -32768, 32767), new ParameterDefn("lcvd", 2, -32768, 32767), new ParameterDefn("lcsz", 1, 1, 32767), new ParameterDefn("lcpt", 168, -128, 127)};
    public static HashSet<String> akSettableParamDefinitions = new HashSet<>();
    private static LinkedHashMap<String, Integer> akAllParamDefinitions_ = new LinkedHashMap<>();
    private static LinkedHashMap<SettingDefn, Integer> settingsDefinitions_ = new LinkedHashMap<>();
    private static boolean constantAkParamsDefined_ = false;
    private static short akParam_genb_ = -1;
    private static short akParam_ienb_ = -1;
    private static short akParam_aonb_ = -1;
    private static int[] akParam_gebf_ = null;

    public static class ParameterDefn {
        public int len;
        public short lowerBound;
        public String paramName;
        public short upperBound;

        public ParameterDefn(String name, int len, int lowerBound, int upperBound) {
            this.paramName = name;
            this.len = len;
            this.lowerBound = (short) lowerBound;
            this.upperBound = (short) upperBound;
        }

        public boolean equals(Object other) {
            if (other instanceof ParameterDefn) {
                return ((ParameterDefn) other).paramName.equalsIgnoreCase(this.paramName) && ((ParameterDefn) other).len == this.len && ((ParameterDefn) other).lowerBound == this.lowerBound && ((ParameterDefn) other).upperBound == this.upperBound;
            }
            return false;
        }

        public int hashCode() {
            return ((Integer) DsAkSettings.akAllParamDefinitions_.get(this.paramName)).intValue();
        }
    }

    protected static class SettingDefn {
        public short offset;
        public byte parameter;

        public SettingDefn(int parameter, int offset) {
            this.parameter = (byte) parameter;
            this.offset = (short) offset;
        }

        public boolean equals(Object other) {
            if (other instanceof SettingDefn) {
                return ((SettingDefn) other).parameter == this.parameter && ((SettingDefn) other).offset == this.offset;
            }
            return false;
        }

        public int hashCode() {
            return (this.parameter * DsAkSettings.akParams_.length) + this.offset;
        }
    }

    static {
        for (int paramIndex = 0; paramIndex < akParams_.length; paramIndex++) {
            akAllParamDefinitions_.put(akParams_[paramIndex].paramName, Integer.valueOf(paramIndex));
            if (isParamSettable(akParams_[paramIndex].paramName)) {
                akSettableParamDefinitions.add(akParams_[paramIndex].paramName);
            }
        }
    }

    public static void setConstantAkParam(String parameter, int[] values) {
        if (parameter.equalsIgnoreCase("genb")) {
            DsLog.log1(LOG_TAG, "The number of GEq bands is " + values[0]);
            int i = getAkParamIndex("gebf");
            akParams_[i].len = values[0];
            int i2 = getAkParamIndex("gebg");
            akParams_[i2].len = values[0];
            int i3 = getAkParamIndex("vcbf");
            akParams_[i3].len = values[0];
            int i4 = getAkParamIndex("vcbg");
            akParams_[i4].len = values[0];
            int i5 = getAkParamIndex("vcbe");
            akParams_[i5].len = values[0];
            akParam_genb_ = (short) values[0];
        } else if (parameter.equalsIgnoreCase("ienb")) {
            DsLog.log1(LOG_TAG, "The number of IEq bands is " + values[0]);
            int i6 = getAkParamIndex("iebf");
            akParams_[i6].len = values[0];
            int i7 = getAkParamIndex("iebt");
            akParams_[i7].len = values[0];
            akParam_ienb_ = (short) values[0];
        } else if (parameter.equalsIgnoreCase("aonb")) {
            DsLog.log1(LOG_TAG, "The number of Audio Optimizer bands is " + values[0]);
            int i8 = getAkParamIndex("aobf");
            akParams_[i8].len = values[0];
            int i9 = getAkParamIndex("aobg");
            akParams_[i9].len = (values[0] + 1) * 2;
            int i10 = getAkParamIndex("arbf");
            akParams_[i10].len = values[0];
            int i11 = getAkParamIndex("arbi");
            akParams_[i11].len = values[0];
            int i12 = getAkParamIndex("arbl");
            akParams_[i12].len = values[0];
            int i13 = getAkParamIndex("arbh");
            akParams_[i13].len = values[0];
            akParam_aonb_ = (short) values[0];
        } else if (parameter.equalsIgnoreCase("gebf")) {
            DsLog.log1(LOG_TAG, "Initializing the graphic equalizer band center frequencies");
            akParam_gebf_ = values;
        }
        if (!constantAkParamsDefined_ && akParam_genb_ != -1 && akParam_ienb_ != -1 && akParam_aonb_ != -1 && akParam_gebf_ != null) {
            defineSettings();
            constantAkParamsDefined_ = true;
        }
    }

    public static int getGeqBandCount() {
        int bandCount = akParam_genb_;
        return bandCount;
    }

    public static int[] getGeqBandFrequencies() {
        return akParam_gebf_;
    }

    public static int getParamArrayLength(String parameter) {
        int i = getAkParamIndex(parameter);
        return i == -1 ? i : akParams_[i].len;
    }

    public static boolean isValidParamValue(int index, short value) {
        return value >= akParams_[index].lowerBound && value <= akParams_[index].upperBound;
    }

    private static boolean isParamSettable(String parameter) {
        return parameter.equalsIgnoreCase("vdhe") || parameter.equalsIgnoreCase("vspe") || parameter.equalsIgnoreCase("dvle") || parameter.equalsIgnoreCase("dvme") || parameter.equalsIgnoreCase("ngon") || parameter.equalsIgnoreCase("ieon") || parameter.equalsIgnoreCase("deon") || parameter.equalsIgnoreCase("geon") || parameter.equalsIgnoreCase("dhsb") || parameter.equalsIgnoreCase("dhrg") || parameter.equalsIgnoreCase("dssb") || parameter.equalsIgnoreCase("dssa") || parameter.equalsIgnoreCase("dssf") || parameter.equalsIgnoreCase("dvla") || parameter.equalsIgnoreCase("iebt") || parameter.equalsIgnoreCase("iea") || parameter.equalsIgnoreCase("dea") || parameter.equalsIgnoreCase("ded") || parameter.equalsIgnoreCase("gebg") || parameter.equalsIgnoreCase("aoon") || parameter.equalsIgnoreCase("plb") || parameter.equalsIgnoreCase("plmd") || parameter.equalsIgnoreCase("vmon") || parameter.equalsIgnoreCase("vmb") || parameter.equalsIgnoreCase("dvli") || parameter.equalsIgnoreCase("dvlo") || parameter.equalsIgnoreCase("dvmc") || parameter.equalsIgnoreCase("ienb") || parameter.equalsIgnoreCase("iebf") || parameter.equalsIgnoreCase("genb") || parameter.equalsIgnoreCase("gebf") || parameter.equalsIgnoreCase("aonb") || parameter.equalsIgnoreCase("aobf") || parameter.equalsIgnoreCase("aobg") || parameter.equalsIgnoreCase("arnb") || parameter.equalsIgnoreCase("arbf") || parameter.equalsIgnoreCase("aocc") || parameter.equalsIgnoreCase("arbi") || parameter.equalsIgnoreCase("arbl") || parameter.equalsIgnoreCase("arbh") || parameter.equalsIgnoreCase("arod") || parameter.equalsIgnoreCase("artp");
    }

    public static int getAkParamIndex(String parameter) {
        Integer i = akAllParamDefinitions_.get(parameter);
        if (i == null) {
            Log.e(LOG_TAG, "getAkParamIndex: parameter " + parameter + " not found!");
        }
        if (i == null) {
            return -1;
        }
        return i.intValue();
    }

    public static int getAkSettingIndex(int parameter, int offset) {
        Integer i = settingsDefinitions_.get(new SettingDefn(parameter, offset));
        if (i == null) {
            return -1;
        }
        return i.intValue();
    }

    public static int getNumOfParams() {
        return akParams_.length;
    }

    public static int getNumElementsPerDevice() {
        return settingsDefinitions_.size();
    }

    public static boolean isConstantAkParamsDefined() {
        return constantAkParamsDefined_;
    }

    public static boolean isAkParamLengthValid(String parameter, int length) {
        if (!isConstantAkParamsDefined()) {
            return true;
        }
        int i = getAkParamIndex(parameter);
        if (length == akParams_[i].len) {
            return true;
        }
        Log.e(LOG_TAG, "In configuration file, the AK parameter " + parameter + " values length " + length + " is NOT compatible to the defined length " + akParams_[i].len);
        return false;
    }

    private static void defineSettings() {
        int elemIndex = 0;
        int elemLen = 0;
        for (int paramIndex = 0; paramIndex < akParams_.length; paramIndex++) {
            if (isParamSettable(akParams_[paramIndex].paramName)) {
                elemLen += akParams_[paramIndex].len;
            }
        }
        settingsDefaults_ = new short[elemLen];
        for (int paramIndex2 = 0; paramIndex2 < akParams_.length; paramIndex2++) {
            if (isParamSettable(akParams_[paramIndex2].paramName)) {
                int nElemPerParam = akParams_[paramIndex2].len;
                if (nElemPerParam == 1) {
                    settingsDefinitions_.put(new SettingDefn(paramIndex2, 0), Integer.valueOf(elemIndex));
                    settingsDefaults_[elemIndex] = 0;
                    elemIndex++;
                } else {
                    for (int i = 0; i < nElemPerParam; i++) {
                        settingsDefinitions_.put(new SettingDefn(paramIndex2, i), Integer.valueOf(elemIndex));
                        settingsDefaults_[elemIndex] = 0;
                        elemIndex++;
                    }
                }
            }
        }
    }

    public static String[] getParamsDefinitions() {
        String[] paramNames = new String[akParams_.length];
        for (int i = 0; i < akParams_.length; i++) {
            paramNames[i] = akParams_[i].paramName;
        }
        return paramNames;
    }

    public static Object[] getSettingsDefinitions() {
        return settingsDefinitions_.keySet().toArray();
    }

    public DsAkSettings() {
        this.values_ = Arrays.copyOf(settingsDefaults_, settingsDefaults_.length);
    }

    public DsAkSettings(DsAkSettings c) {
        this.values_ = Arrays.copyOf(c.getValues(), c.getValues().length);
    }

    public DsAkSettings(int[][] settings) {
        this();
        set(settings);
    }

    short[] getValues() {
        return this.values_;
    }

    private boolean isParamValueConflicted(int paramIndex, int offset, short value) {
        if (constantAkParamsDefined_) {
            if (paramIndex == getAkParamIndex("genb") && value != akParam_genb_) {
                Log.e(LOG_TAG, "genb = " + ((int) value) + " conflicts with the predefined value " + ((int) akParam_genb_));
                return true;
            }
            if (paramIndex == getAkParamIndex("ienb") && value != akParam_ienb_) {
                Log.e(LOG_TAG, "ienb = " + ((int) value) + " conflicts with the predefined value " + ((int) akParam_ienb_));
                return true;
            }
            if (paramIndex == getAkParamIndex("aonb") && value != akParam_aonb_) {
                Log.e(LOG_TAG, "aonb = " + ((int) value) + " conflicts with the predefined value " + ((int) akParam_aonb_));
                return true;
            }
            if (paramIndex == getAkParamIndex("arnb") && value != akParam_aonb_) {
                Log.e(LOG_TAG, "arnb = " + ((int) value) + " conflicts with the predefined value " + ((int) akParam_aonb_));
                return true;
            }
            if (paramIndex != getAkParamIndex("aocc") || value == 2) {
                return false;
            }
            Log.e(LOG_TAG, "aocc = " + ((int) value) + " conflicts with the predefined value 2");
            return true;
        }
        Log.e(LOG_TAG, "Settable settings not defined yet");
        return true;
    }

    public void set(int[][] settings) throws IllegalArgumentException {
        for (int[] fpv : settings) {
            if (fpv.length != 3) {
                throw new IllegalArgumentException("Each setting must contain an array of 3 ints declared as int[3]");
            }
            int i = fpv[0];
            fpv[2] = set(akParams_[i].paramName, fpv[1], (short) fpv[2]);
        }
    }

    public void set(String parameter, short[] values) throws IllegalArgumentException {
        int paramIndex = getAkParamIndex(parameter);
        int i = getAkSettingIndex(paramIndex, 0);
        if (i == -1) {
            throw new IllegalArgumentException("The parameter and offset combination is not allowed");
        }
        int paramLen = akParams_[paramIndex].len;
        int len = values.length < paramLen ? values.length : paramLen;
        for (int j = 0; j < len; j++) {
            values[j] = values[j] < akParams_[paramIndex].lowerBound ? akParams_[paramIndex].lowerBound : values[j];
            values[j] = values[j] > akParams_[paramIndex].upperBound ? akParams_[paramIndex].upperBound : values[j];
            this.values_[i + j] = values[j];
        }
        DsLog.log1(LOG_TAG, "set: (parameter:" + parameter + " values:" + values + ")");
    }

    public short set(String parameter, int offset, short value) throws IllegalArgumentException {
        int paramIndex = getAkParamIndex(parameter);
        if (isParamValueConflicted(paramIndex, offset, value)) {
            throw new IllegalArgumentException("The parameter value conflicts with the pre-defined value");
        }
        int i = getAkSettingIndex(paramIndex, offset);
        if (i == -1) {
            throw new IllegalArgumentException("The parameter and offset combination is not allowed");
        }
        if (!isValidParamValue(paramIndex, value)) {
            DsLog.log1(LOG_TAG, "value " + ((int) value) + " for parameter " + parameter + " is out of valid range");
            if (value < akParams_[paramIndex].lowerBound) {
                value = akParams_[paramIndex].lowerBound;
            }
            if (value > akParams_[paramIndex].upperBound) {
                value = akParams_[paramIndex].upperBound;
            }
            DsLog.log1(LOG_TAG, "Clamp the value to the upper/lower bound " + ((int) value));
        }
        this.values_[i] = value;
        DsLog.log2(LOG_TAG, "set: (parameter:" + parameter + " offset:" + offset + " value:" + ((int) value) + ")");
        return value;
    }

    public short[] get(String parameter) throws IllegalArgumentException {
        int paramIndex = getAkParamIndex(parameter);
        int i = getAkSettingIndex(paramIndex, 0);
        if (i == -1) {
            throw new IllegalArgumentException("The parameter and offset combination is not allowed");
        }
        int length = akParams_[paramIndex].len;
        short[] values = new short[length];
        for (int j = 0; j < length; j++) {
            values[j] = this.values_[i + j];
        }
        return values;
    }

    public short get(String parameter, int offset) {
        int paramIndex = getAkParamIndex(parameter);
        int i = getAkSettingIndex(paramIndex, offset);
        if (i == -1) {
            throw new IllegalArgumentException("The parameter and offset combination is not allowed");
        }
        return this.values_[i];
    }
}
