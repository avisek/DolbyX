package android.dolby.ds;

import android.dolby.DsLog;
import android.dolby.ds.DsAkSettings;
import android.media.audiofx.AudioEffect;
import android.util.Log;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Map;
import java.util.UUID;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public class DsEffect {
    protected static final int DS_PARAM_ALL_VALUES = 2;
    protected static final int DS_PARAM_DEFINE_PARAMS = 5;
    protected static final int DS_PARAM_DEFINE_SETTINGS = 1;
    protected static final int DS_PARAM_SINGLE_DEVICE_VALUE = 3;
    protected static final int DS_PARAM_TUNING = 0;
    protected static final int DS_PARAM_VERSION = 6;
    protected static final int DS_PARAM_VISUALIZER_DATA = 4;
    protected static final int DS_PARAM_VISUALIZER_ENABLE = 7;
    private static final String LOG_TAG = "DsEffect";
    protected AudioEffect audioEffect;
    private int audioSessionId_;
    protected Class classAudioEffect;
    protected Method methodGetParameter;
    protected Method methodSetParameter;
    UUID nxp_env_reverb_uuid = UUID.fromString("4a387fc0-8ab3-11df-8bad-0002a5d5c51b");
    public static final UUID EFFECT_TYPE_NULL = UUID.fromString("ec7178ec-e5e1-4432-a3f4-4657e6795210");
    public static final UUID EFFECT_TYPE_DS = UUID.fromString("46d279d9-9be7-453d-9d7c-ef937f675587");
    public static final UUID EFFECT_DS = UUID.fromString("9d4921da-8225-4f29-aefa-39537a04bcaa");

    public DsEffect(int audioSessionId) throws IllegalAccessException, NoSuchMethodException, InstantiationException, ClassNotFoundException, RuntimeException, InvocationTargetException {
        this.classAudioEffect = null;
        this.audioEffect = null;
        this.methodSetParameter = null;
        this.methodGetParameter = null;
        try {
            this.classAudioEffect = Class.forName("android.media.audiofx.AudioEffect");
            try {
                Constructor ctorAudioEffect = this.classAudioEffect.getConstructor(UUID.class, UUID.class, Integer.TYPE, Integer.TYPE);
                DsLog.log2(LOG_TAG, "Found AudioEffect Constructor");
                try {
                    this.audioEffect = (AudioEffect) ctorAudioEffect.newInstance(EFFECT_TYPE_NULL, EFFECT_DS, 0, Integer.valueOf(audioSessionId));
                    DsLog.log2(LOG_TAG, "Created Ds AudioEffect successfully");
                    AudioEffect.Descriptor e = this.audioEffect.getDescriptor();
                    this.methodSetParameter = this.classAudioEffect.getMethod("setParameter", byte[].class, byte[].class);
                    this.methodGetParameter = this.classAudioEffect.getMethod("getParameter", byte[].class, byte[].class);
                    DsLog.log1(LOG_TAG, "CREATED EFFECT Implementor:\"" + e.implementor + "\"\n name:\"" + e.name + "\"\n connectMode:\"" + e.connectMode + "\"\n type:\"" + e.type.toString() + "\"\n uuid:\"" + e.uuid.toString() + "\"\n sessionID:\"" + audioSessionId + "\"");
                    _setDefineParams();
                    _setDefineSettings();
                    this.audioSessionId_ = audioSessionId;
                } catch (IllegalAccessException e2) {
                    e2.printStackTrace();
                    Log.e(LOG_TAG, e2.toString());
                    throw e2;
                } catch (IllegalArgumentException e3) {
                    e3.printStackTrace();
                    Log.e(LOG_TAG, e3.toString());
                    throw e3;
                } catch (InstantiationException e4) {
                    e4.printStackTrace();
                    Log.e(LOG_TAG, e4.toString());
                    throw e4;
                } catch (InvocationTargetException e5) {
                    e5.printStackTrace();
                    Log.e(LOG_TAG, e5.toString());
                    throw e5;
                }
            } catch (NoSuchMethodException e6) {
                Log.e(LOG_TAG, e6.toString());
                throw e6;
            } catch (SecurityException e7) {
                Log.e(LOG_TAG, e7.toString());
                throw e7;
            }
        } catch (ClassNotFoundException e8) {
            e8.printStackTrace();
            Log.e(LOG_TAG, e8.toString());
            throw e8;
        }
    }

    public void release() {
        this.audioEffect.release();
    }

    public int setEnabled(boolean enabled) throws IllegalStateException {
        return this.audioEffect.setEnabled(enabled);
    }

    public boolean getEnabled() throws IllegalStateException {
        return this.audioEffect.getEnabled();
    }

    public boolean hasControl() throws IllegalStateException {
        return this.audioEffect.hasControl();
    }

    private byte[] intToByteArray(int value) {
        ByteBuffer converter = ByteBuffer.allocate(4);
        converter.order(ByteOrder.nativeOrder());
        converter.putInt(value);
        return converter.array();
    }

    private static byte[] IntArrayToByteArray(int[] src) {
        int srcLength = src.length;
        byte[] dst = new byte[srcLength << 2];
        for (int i = 0; i < srcLength; i++) {
            int x = src[i];
            int j = i << 2;
            int j2 = j + 1;
            dst[j] = (byte) ((x >>> 0) & 255);
            int j3 = j2 + 1;
            dst[j2] = (byte) ((x >>> 8) & 255);
            int j4 = j3 + 1;
            dst[j3] = (byte) ((x >>> 16) & 255);
            int i2 = j4 + 1;
            dst[j4] = (byte) ((x >>> 24) & 255);
        }
        return dst;
    }

    private static int SetInt16InByteArray(int value, byte[] dst, int index) {
        dst[index] = (byte) (value & 255);
        dst[index + 1] = (byte) ((value >>> 8) & 255);
        return 2;
    }

    private static int SetInt32InByteArray(int value, byte[] dst, int index) {
        int index2 = index + 1;
        dst[index] = (byte) (value & 255);
        int index3 = index2 + 1;
        dst[index2] = (byte) ((value >>> 8) & 255);
        dst[index3] = (byte) ((value >>> 16) & 255);
        dst[index3 + 1] = (byte) ((value >>> 24) & 255);
        return 4;
    }

    private static int Set4ChInByteArray(String src, byte[] dst, int index) throws IllegalArgumentException {
        int len = src.length();
        if (len > 4) {
            Log.e(LOG_TAG, "parameter name " + src + " contains more than 4 characters");
            throw new IllegalArgumentException("Wrong parameter name");
        }
        int i = 0;
        int index2 = index;
        while (i < len) {
            dst[index2] = (byte) src.charAt(i);
            i++;
            index2++;
        }
        if (len < 4) {
            dst[index2] = 0;
        }
        return 4;
    }

    private static int ByteArrayToInt(byte[] ba) {
        return ((ba[3] & 255) << 24) | ((ba[2] & 255) << 16) | ((ba[1] & 255) << 8) | (ba[0] & 255);
    }

    private static int[] ByteArrayToIntArray(byte[] ba) {
        int srcLength = ba.length;
        int destLength = srcLength >> 2;
        int[] dest = new int[destLength];
        for (int i = 0; i < destLength; i++) {
            dest[i] = ((ba[(i * 4) + 3] & 255) << 24) | ((ba[(i * 4) + 2] & 255) << 16) | ((ba[(i * 4) + 1] & 255) << 8) | (ba[i * 4] & 255);
        }
        return dest;
    }

    private static short[] ByteArrayToShortArray(byte[] ba) {
        int srcLength = ba.length;
        int destLength = srcLength >> 1;
        short[] dest = new short[destLength];
        for (int i = 0; i < destLength; i++) {
            dest[i] = (short) (((ba[(i * 2) + 1] & 255) << 8) | (ba[i * 2] & 255));
        }
        return dest;
    }

    private static String ByteArrayToString(byte[] ba) {
        StringBuilder sb = new StringBuilder((ba.length * 6) + 3);
        sb.append("HEX(");
        for (byte b : ba) {
            sb.append(Integer.toHexString(b));
            sb.append(' ');
        }
        sb.append(')');
        return sb.toString();
    }

    private int _invokeSetParameter(byte[] baParam, byte[] baValue) {
        DsLog.log1(LOG_TAG, "_invokeSetParameter baParam:" + ByteArrayToString(baParam) + "\n baValue:" + ByteArrayToString(baValue));
        try {
            int iRet = ((Integer) this.methodSetParameter.invoke(this.audioEffect, baParam, baValue)).intValue();
            DsLog.log3(LOG_TAG, "_invokeSetParameter returning.");
            return iRet;
        } catch (IllegalAccessException e) {
            e.printStackTrace();
            Log.e(LOG_TAG, e.toString());
            return -5;
        } catch (IllegalArgumentException e2) {
            e2.printStackTrace();
            Log.e(LOG_TAG, e2.toString());
            return -4;
        } catch (InvocationTargetException e3) {
            e3.printStackTrace();
            Log.e(LOG_TAG, e3.toString());
            return -5;
        }
    }

    private int _invokeGetParameter(byte[] baParam, byte[] baValue) {
        try {
            int count = ((Integer) this.methodGetParameter.invoke(this.audioEffect, baParam, baValue)).intValue();
            DsLog.log3(LOG_TAG, "_invokeGetParameter baParam:" + ByteArrayToString(baParam) + "\n baValue:" + ByteArrayToString(baValue));
            DsLog.log3(LOG_TAG, "_invokeGetParameter returning:" + count);
            return count;
        } catch (IllegalAccessException e) {
            e.printStackTrace();
            Log.e(LOG_TAG, e.toString());
            return -5;
        } catch (IllegalArgumentException e2) {
            e2.printStackTrace();
            Log.e(LOG_TAG, e2.toString());
            return -4;
        } catch (InvocationTargetException e3) {
            e3.printStackTrace();
            Log.e(LOG_TAG, e3.toString());
            return -5;
        }
    }

    private int _getIntArrayParameter(int param, int[] value) {
        byte[] baParam = intToByteArray(param);
        byte[] baValue = new byte[value.length << 2];
        int count = _invokeGetParameter(baParam, baValue);
        if (count != (value.length << 2)) {
            Log.e(LOG_TAG, "_getIntArrayParameter: Error in getting the parameter!");
        } else {
            int[] tmpValue = ByteArrayToIntArray(baValue);
            System.arraycopy(tmpValue, 0, value, 0, value.length);
        }
        return count;
    }

    private int _getShortArrayParameter(int param, short[] value) {
        byte[] baParam = intToByteArray(param);
        byte[] baValue = new byte[value.length << 1];
        int count = _invokeGetParameter(baParam, baValue);
        if (count != (value.length << 1)) {
            DsLog.log2(LOG_TAG, "_getShortArrayParameter: Unexpected length");
        } else {
            short[] tmpValue = ByteArrayToShortArray(baValue);
            System.arraycopy(tmpValue, 0, value, 0, tmpValue.length);
        }
        return count;
    }

    private void _setDefineParams() {
        byte[] baParam = intToByteArray(5);
        byte[] baValue = new byte[(DsAkSettings.getNumOfParams() * 4) + 2];
        int index = 0 + SetInt16InByteArray(DsAkSettings.getNumOfParams(), baValue, 0);
        String[] defns = DsAkSettings.getParamsDefinitions();
        for (String str : defns) {
            index += Set4ChInByteArray(str, baValue, index);
        }
        _invokeSetParameter(baParam, baValue);
    }

    private void _setDefineSettings() {
        byte[] baParam = intToByteArray(1);
        byte[] baValue = new byte[(DsAkSettings.getNumElementsPerDevice() * 3) + 2];
        int index = 0 + SetInt16InByteArray(DsAkSettings.getNumElementsPerDevice(), baValue, 0);
        Object[] defns = DsAkSettings.getSettingsDefinitions();
        for (int i = 0; i < defns.length; i++) {
            baValue[index] = ((DsAkSettings.SettingDefn) defns[i]).parameter;
            int index2 = index + 1;
            index = index2 + SetInt16InByteArray(((DsAkSettings.SettingDefn) defns[i]).offset, baValue, index2);
        }
        _invokeSetParameter(baParam, baValue);
    }

    public void setTuningSettings(Map<String, int[]> settings) {
        DsLog.log1(LOG_TAG, "setTuningSettings");
    }

    public int setAllProfileSettings(DsProfileSettings settings) {
        DsLog.log1(LOG_TAG, "setAllProfileSettings");
        return setAllSettings(settings.getAllSettings());
    }

    public int setVisualizerOn(boolean enable) {
        DsLog.log1(LOG_TAG, "setVisualizerOn");
        int on = enable ? 1 : 0;
        byte[] baParam = intToByteArray(7);
        byte[] baValue = new byte[4];
        int iSetInt32InByteArray = 0 + SetInt32InByteArray(on, baValue, 0);
        return _invokeSetParameter(baParam, baValue);
    }

    public boolean getVisualizerOn() {
        DsLog.log1(LOG_TAG, "getVisualizerOn");
        byte[] baParam = intToByteArray(7);
        byte[] baValue = new byte[4];
        int count = _invokeGetParameter(baParam, baValue);
        if (count != 4) {
            Log.e(LOG_TAG, "getVisualizerOn: Error in getting the visualizer on/off state!");
            return false;
        }
        int on = ByteArrayToInt(baValue);
        return on == 1;
    }

    public short[] getVisualizerData() {
        DsLog.log3(LOG_TAG, "getVisualizerData");
        int numVisualizerData = DsAkSettings.getParamArrayLength("vcbg") + DsAkSettings.getParamArrayLength("vcbe");
        short[] visualizerData = new short[numVisualizerData];
        int count = _getShortArrayParameter(4, visualizerData);
        if (count != (visualizerData.length << 1)) {
            return null;
        }
        return visualizerData;
    }

    public int setSingleSetting(int parameter, int offset, short[] values, AudioDevice device) {
        if (values.length == 1) {
            DsLog.log1(LOG_TAG, "setSingleSetting: device " + device + ", parameter " + parameter + ", offset " + offset);
        } else {
            int offsetEnd = (values.length + offset) - 1;
            DsLog.log1(LOG_TAG, "setSingleSetting: device " + device + ", parameter " + parameter + ", offset [" + offset + "-" + offsetEnd + "]");
        }
        int begin = DsAkSettings.getAkSettingIndex(parameter, offset);
        int end = DsAkSettings.getAkSettingIndex(parameter, (values.length + offset) - 1);
        if (begin == -1 || end == -1) {
            Log.e(LOG_TAG, "Attempt to set disallowed parameter and offset combination");
            return -5;
        }
        byte[] baParam = intToByteArray(3);
        byte[] baValue = new byte[(values.length * 2) + 8];
        int index = 0 + SetInt32InByteArray(device.toInt(), baValue, 0);
        int index2 = index + SetInt16InByteArray(begin, baValue, index);
        int index3 = index2 + SetInt16InByteArray(values.length, baValue, index2);
        for (short s : values) {
            index3 += SetInt16InByteArray(s, baValue, index3);
        }
        return _invokeSetParameter(baParam, baValue);
    }

    public int setAllSettings(Map<AudioDevice, DsAkSettings> allSettings) {
        byte[] baParam = intToByteArray(2);
        int nDevCount = allSettings.size();
        byte[] baValue = new byte[(((DsAkSettings.getNumElementsPerDevice() * 2) + 4) * nDevCount) + 2];
        int index = 0 + SetInt16InByteArray(nDevCount, baValue, 0);
        for (AudioDevice device : allSettings.keySet()) {
            DsAkSettings s = allSettings.get(device);
            index += SetInt32InByteArray(device.toInt(), baValue, index);
            short[] values = s.getValues();
            for (short s2 : values) {
                index += SetInt16InByteArray(s2, baValue, index);
            }
        }
        return _invokeSetParameter(baParam, baValue);
    }

    public short[] getVersion() {
        int verLen = DsAkSettings.getParamArrayLength("ver");
        short[] version = new short[verLen];
        int count = _getShortArrayParameter(6, version);
        if (count != (version.length << 1)) {
            Log.e(LOG_TAG, "getVersion(): Error in getting the version");
            for (int i = 0; i < verLen; i++) {
                version[i] = -1;
            }
        }
        return version;
    }
}
