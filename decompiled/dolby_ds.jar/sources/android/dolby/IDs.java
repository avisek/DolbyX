package android.dolby;

import android.dolby.IDsServiceCallbacks;
import android.os.Binder;
import android.os.IBinder;
import android.os.IInterface;
import android.os.Parcel;
import android.os.RemoteException;

/* JADX INFO: loaded from: /tmp/decompiler/67450c8dfb8931b9934a447bc79033dc/classes.dex */
public interface IDs extends IInterface {
    int getBandCount(int[] iArr) throws RemoteException;

    int getBandFrequencies(int[] iArr) throws RemoteException;

    int getDsApParam(String str, int[] iArr) throws RemoteException;

    int getDsApParamLength(String str, int[] iArr) throws RemoteException;

    int getDsApVersion(String[] strArr) throws RemoteException;

    int getDsOn(boolean[] zArr) throws RemoteException;

    int getDsVersion(String[] strArr) throws RemoteException;

    int getGeq(int i, int i2, float[] fArr) throws RemoteException;

    int getIeqPreset(int i, int[] iArr) throws RemoteException;

    int getMonoSpeaker(boolean[] zArr) throws RemoteException;

    int getProfileCount(int[] iArr) throws RemoteException;

    int getProfileModified(int i, int[] iArr) throws RemoteException;

    int getProfileNames(String[] strArr) throws RemoteException;

    int getProfileSettings(int i, DsClientSettings[] dsClientSettingsArr) throws RemoteException;

    int getSelectedProfile(int[] iArr) throws RemoteException;

    void registerCallback(IDsServiceCallbacks iDsServiceCallbacks, int i) throws RemoteException;

    void registerDsApParamEvents(int i) throws RemoteException;

    void registerVisualizerData(int i) throws RemoteException;

    int resetProfile(int i, int i2) throws RemoteException;

    int setDsApParam(int i, String str, int[] iArr) throws RemoteException;

    int setDsOn(int i, boolean z) throws RemoteException;

    int setGeq(int i, int i2, int i3, float[] fArr) throws RemoteException;

    int setIeqPreset(int i, int i2, int i3) throws RemoteException;

    int setNonPersistentMode(boolean z) throws RemoteException;

    int setProfileName(int i, int i2, String str) throws RemoteException;

    int setProfileSettings(int i, int i2, DsClientSettings dsClientSettings) throws RemoteException;

    int setSelectedProfile(int i, int i2) throws RemoteException;

    void unregisterCallback(IDsServiceCallbacks iDsServiceCallbacks) throws RemoteException;

    void unregisterDsApParamEvents(int i) throws RemoteException;

    void unregisterVisualizerData(int i) throws RemoteException;

    public static abstract class Stub extends Binder implements IDs {
        private static final String DESCRIPTOR = "android.dolby.IDs";
        static final int TRANSACTION_getBandCount = 6;
        static final int TRANSACTION_getBandFrequencies = 7;
        static final int TRANSACTION_getDsApParam = 23;
        static final int TRANSACTION_getDsApParamLength = 24;
        static final int TRANSACTION_getDsApVersion = 14;
        static final int TRANSACTION_getDsOn = 2;
        static final int TRANSACTION_getDsVersion = 16;
        static final int TRANSACTION_getGeq = 21;
        static final int TRANSACTION_getIeqPreset = 18;
        static final int TRANSACTION_getMonoSpeaker = 15;
        static final int TRANSACTION_getProfileCount = 4;
        static final int TRANSACTION_getProfileModified = 19;
        static final int TRANSACTION_getProfileNames = 5;
        static final int TRANSACTION_getProfileSettings = 11;
        static final int TRANSACTION_getSelectedProfile = 9;
        static final int TRANSACTION_registerCallback = 27;
        static final int TRANSACTION_registerDsApParamEvents = 25;
        static final int TRANSACTION_registerVisualizerData = 29;
        static final int TRANSACTION_resetProfile = 12;
        static final int TRANSACTION_setDsApParam = 22;
        static final int TRANSACTION_setDsOn = 1;
        static final int TRANSACTION_setGeq = 20;
        static final int TRANSACTION_setIeqPreset = 17;
        static final int TRANSACTION_setNonPersistentMode = 3;
        static final int TRANSACTION_setProfileName = 13;
        static final int TRANSACTION_setProfileSettings = 10;
        static final int TRANSACTION_setSelectedProfile = 8;
        static final int TRANSACTION_unregisterCallback = 28;
        static final int TRANSACTION_unregisterDsApParamEvents = 26;
        static final int TRANSACTION_unregisterVisualizerData = 30;

        public Stub() {
            attachInterface(this, DESCRIPTOR);
        }

        public static IDs asInterface(IBinder obj) {
            if (obj == null) {
                return null;
            }
            IInterface iin = obj.queryLocalInterface(DESCRIPTOR);
            if (iin != null && (iin instanceof IDs)) {
                return (IDs) iin;
            }
            return new Proxy(obj);
        }

        @Override // android.os.IInterface
        public IBinder asBinder() {
            return this;
        }

        @Override // android.os.Binder
        public boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
            int[] _arg1;
            int[] _arg12;
            float[] _arg2;
            int[] _arg13;
            int[] _arg14;
            String[] _arg0;
            boolean[] _arg02;
            String[] _arg03;
            DsClientSettings[] _arg15;
            DsClientSettings _arg22;
            int[] _arg04;
            int[] _arg05;
            int[] _arg06;
            String[] _arg07;
            int[] _arg08;
            boolean[] _arg09;
            switch (code) {
                case 1:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg010 = data.readInt();
                    boolean _arg16 = data.readInt() != 0;
                    int _result = setDsOn(_arg010, _arg16);
                    reply.writeNoException();
                    reply.writeInt(_result);
                    return true;
                case 2:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length = data.readInt();
                    if (_arg0_length < 0) {
                        _arg09 = null;
                    } else {
                        _arg09 = new boolean[_arg0_length];
                    }
                    int _result2 = getDsOn(_arg09);
                    reply.writeNoException();
                    reply.writeInt(_result2);
                    reply.writeBooleanArray(_arg09);
                    return true;
                case 3:
                    data.enforceInterface(DESCRIPTOR);
                    boolean _arg011 = data.readInt() != 0;
                    int _result3 = setNonPersistentMode(_arg011);
                    reply.writeNoException();
                    reply.writeInt(_result3);
                    return true;
                case 4:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length2 = data.readInt();
                    if (_arg0_length2 < 0) {
                        _arg08 = null;
                    } else {
                        _arg08 = new int[_arg0_length2];
                    }
                    int _result4 = getProfileCount(_arg08);
                    reply.writeNoException();
                    reply.writeInt(_result4);
                    reply.writeIntArray(_arg08);
                    return true;
                case 5:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length3 = data.readInt();
                    if (_arg0_length3 < 0) {
                        _arg07 = null;
                    } else {
                        _arg07 = new String[_arg0_length3];
                    }
                    int _result5 = getProfileNames(_arg07);
                    reply.writeNoException();
                    reply.writeInt(_result5);
                    reply.writeStringArray(_arg07);
                    return true;
                case 6:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length4 = data.readInt();
                    if (_arg0_length4 < 0) {
                        _arg06 = null;
                    } else {
                        _arg06 = new int[_arg0_length4];
                    }
                    int _result6 = getBandCount(_arg06);
                    reply.writeNoException();
                    reply.writeInt(_result6);
                    reply.writeIntArray(_arg06);
                    return true;
                case 7:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length5 = data.readInt();
                    if (_arg0_length5 < 0) {
                        _arg05 = null;
                    } else {
                        _arg05 = new int[_arg0_length5];
                    }
                    int _result7 = getBandFrequencies(_arg05);
                    reply.writeNoException();
                    reply.writeInt(_result7);
                    reply.writeIntArray(_arg05);
                    return true;
                case 8:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg012 = data.readInt();
                    int _arg17 = data.readInt();
                    int _result8 = setSelectedProfile(_arg012, _arg17);
                    reply.writeNoException();
                    reply.writeInt(_result8);
                    return true;
                case TRANSACTION_getSelectedProfile /* 9 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length6 = data.readInt();
                    if (_arg0_length6 < 0) {
                        _arg04 = null;
                    } else {
                        _arg04 = new int[_arg0_length6];
                    }
                    int _result9 = getSelectedProfile(_arg04);
                    reply.writeNoException();
                    reply.writeInt(_result9);
                    reply.writeIntArray(_arg04);
                    return true;
                case TRANSACTION_setProfileSettings /* 10 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg013 = data.readInt();
                    int _arg18 = data.readInt();
                    if (data.readInt() != 0) {
                        _arg22 = DsClientSettings.CREATOR.createFromParcel(data);
                    } else {
                        _arg22 = null;
                    }
                    int _result10 = setProfileSettings(_arg013, _arg18, _arg22);
                    reply.writeNoException();
                    reply.writeInt(_result10);
                    return true;
                case TRANSACTION_getProfileSettings /* 11 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg014 = data.readInt();
                    int _arg1_length = data.readInt();
                    if (_arg1_length < 0) {
                        _arg15 = null;
                    } else {
                        _arg15 = new DsClientSettings[_arg1_length];
                    }
                    int _result11 = getProfileSettings(_arg014, _arg15);
                    reply.writeNoException();
                    reply.writeInt(_result11);
                    reply.writeTypedArray(_arg15, 1);
                    return true;
                case TRANSACTION_resetProfile /* 12 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg015 = data.readInt();
                    int _arg19 = data.readInt();
                    int _result12 = resetProfile(_arg015, _arg19);
                    reply.writeNoException();
                    reply.writeInt(_result12);
                    return true;
                case TRANSACTION_setProfileName /* 13 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg016 = data.readInt();
                    int _arg110 = data.readInt();
                    String _arg23 = data.readString();
                    int _result13 = setProfileName(_arg016, _arg110, _arg23);
                    reply.writeNoException();
                    reply.writeInt(_result13);
                    return true;
                case TRANSACTION_getDsApVersion /* 14 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length7 = data.readInt();
                    if (_arg0_length7 < 0) {
                        _arg03 = null;
                    } else {
                        _arg03 = new String[_arg0_length7];
                    }
                    int _result14 = getDsApVersion(_arg03);
                    reply.writeNoException();
                    reply.writeInt(_result14);
                    reply.writeStringArray(_arg03);
                    return true;
                case TRANSACTION_getMonoSpeaker /* 15 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length8 = data.readInt();
                    if (_arg0_length8 < 0) {
                        _arg02 = null;
                    } else {
                        _arg02 = new boolean[_arg0_length8];
                    }
                    int _result15 = getMonoSpeaker(_arg02);
                    reply.writeNoException();
                    reply.writeInt(_result15);
                    reply.writeBooleanArray(_arg02);
                    return true;
                case 16:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg0_length9 = data.readInt();
                    if (_arg0_length9 < 0) {
                        _arg0 = null;
                    } else {
                        _arg0 = new String[_arg0_length9];
                    }
                    int _result16 = getDsVersion(_arg0);
                    reply.writeNoException();
                    reply.writeInt(_result16);
                    reply.writeStringArray(_arg0);
                    return true;
                case 17:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg017 = data.readInt();
                    int _arg111 = data.readInt();
                    int _arg24 = data.readInt();
                    int _result17 = setIeqPreset(_arg017, _arg111, _arg24);
                    reply.writeNoException();
                    reply.writeInt(_result17);
                    return true;
                case TRANSACTION_getIeqPreset /* 18 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg018 = data.readInt();
                    int _arg1_length2 = data.readInt();
                    if (_arg1_length2 < 0) {
                        _arg14 = null;
                    } else {
                        _arg14 = new int[_arg1_length2];
                    }
                    int _result18 = getIeqPreset(_arg018, _arg14);
                    reply.writeNoException();
                    reply.writeInt(_result18);
                    reply.writeIntArray(_arg14);
                    return true;
                case TRANSACTION_getProfileModified /* 19 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg019 = data.readInt();
                    int _arg1_length3 = data.readInt();
                    if (_arg1_length3 < 0) {
                        _arg13 = null;
                    } else {
                        _arg13 = new int[_arg1_length3];
                    }
                    int _result19 = getProfileModified(_arg019, _arg13);
                    reply.writeNoException();
                    reply.writeInt(_result19);
                    reply.writeIntArray(_arg13);
                    return true;
                case TRANSACTION_setGeq /* 20 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg020 = data.readInt();
                    int _arg112 = data.readInt();
                    int _arg25 = data.readInt();
                    float[] _arg3 = data.createFloatArray();
                    int _result20 = setGeq(_arg020, _arg112, _arg25, _arg3);
                    reply.writeNoException();
                    reply.writeInt(_result20);
                    return true;
                case TRANSACTION_getGeq /* 21 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg021 = data.readInt();
                    int _arg113 = data.readInt();
                    int _arg2_length = data.readInt();
                    if (_arg2_length < 0) {
                        _arg2 = null;
                    } else {
                        _arg2 = new float[_arg2_length];
                    }
                    int _result21 = getGeq(_arg021, _arg113, _arg2);
                    reply.writeNoException();
                    reply.writeInt(_result21);
                    reply.writeFloatArray(_arg2);
                    return true;
                case TRANSACTION_setDsApParam /* 22 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg022 = data.readInt();
                    String _arg114 = data.readString();
                    int[] _arg26 = data.createIntArray();
                    int _result22 = setDsApParam(_arg022, _arg114, _arg26);
                    reply.writeNoException();
                    reply.writeInt(_result22);
                    return true;
                case TRANSACTION_getDsApParam /* 23 */:
                    data.enforceInterface(DESCRIPTOR);
                    String _arg023 = data.readString();
                    int _arg1_length4 = data.readInt();
                    if (_arg1_length4 < 0) {
                        _arg12 = null;
                    } else {
                        _arg12 = new int[_arg1_length4];
                    }
                    int _result23 = getDsApParam(_arg023, _arg12);
                    reply.writeNoException();
                    reply.writeInt(_result23);
                    reply.writeIntArray(_arg12);
                    return true;
                case TRANSACTION_getDsApParamLength /* 24 */:
                    data.enforceInterface(DESCRIPTOR);
                    String _arg024 = data.readString();
                    int _arg1_length5 = data.readInt();
                    if (_arg1_length5 < 0) {
                        _arg1 = null;
                    } else {
                        _arg1 = new int[_arg1_length5];
                    }
                    int _result24 = getDsApParamLength(_arg024, _arg1);
                    reply.writeNoException();
                    reply.writeInt(_result24);
                    reply.writeIntArray(_arg1);
                    return true;
                case TRANSACTION_registerDsApParamEvents /* 25 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg025 = data.readInt();
                    registerDsApParamEvents(_arg025);
                    reply.writeNoException();
                    return true;
                case TRANSACTION_unregisterDsApParamEvents /* 26 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg026 = data.readInt();
                    unregisterDsApParamEvents(_arg026);
                    reply.writeNoException();
                    return true;
                case TRANSACTION_registerCallback /* 27 */:
                    data.enforceInterface(DESCRIPTOR);
                    IDsServiceCallbacks _arg027 = IDsServiceCallbacks.Stub.asInterface(data.readStrongBinder());
                    int _arg115 = data.readInt();
                    registerCallback(_arg027, _arg115);
                    reply.writeNoException();
                    return true;
                case TRANSACTION_unregisterCallback /* 28 */:
                    data.enforceInterface(DESCRIPTOR);
                    IDsServiceCallbacks _arg028 = IDsServiceCallbacks.Stub.asInterface(data.readStrongBinder());
                    unregisterCallback(_arg028);
                    reply.writeNoException();
                    return true;
                case TRANSACTION_registerVisualizerData /* 29 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg029 = data.readInt();
                    registerVisualizerData(_arg029);
                    reply.writeNoException();
                    return true;
                case TRANSACTION_unregisterVisualizerData /* 30 */:
                    data.enforceInterface(DESCRIPTOR);
                    int _arg030 = data.readInt();
                    unregisterVisualizerData(_arg030);
                    reply.writeNoException();
                    return true;
                case 1598968902:
                    reply.writeString(DESCRIPTOR);
                    return true;
                default:
                    return super.onTransact(code, data, reply, flags);
            }
        }

        private static class Proxy implements IDs {
            private IBinder mRemote;

            Proxy(IBinder remote) {
                this.mRemote = remote;
            }

            @Override // android.os.IInterface
            public IBinder asBinder() {
                return this.mRemote;
            }

            public String getInterfaceDescriptor() {
                return Stub.DESCRIPTOR;
            }

            @Override // android.dolby.IDs
            public int setDsOn(int handle, boolean on) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeInt(on ? 1 : 0);
                    this.mRemote.transact(1, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getDsOn(boolean[] on) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (on == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(on.length);
                    }
                    this.mRemote.transact(2, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readBooleanArray(on);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int setNonPersistentMode(boolean on) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(on ? 1 : 0);
                    this.mRemote.transact(3, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getProfileCount(int[] count) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (count == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(count.length);
                    }
                    this.mRemote.transact(4, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(count);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getProfileNames(String[] names) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (names == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(names.length);
                    }
                    this.mRemote.transact(5, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readStringArray(names);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getBandCount(int[] count) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (count == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(count.length);
                    }
                    this.mRemote.transact(6, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(count);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getBandFrequencies(int[] frequencies) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (frequencies == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(frequencies.length);
                    }
                    this.mRemote.transact(7, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(frequencies);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int setSelectedProfile(int handle, int profile) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeInt(profile);
                    this.mRemote.transact(8, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getSelectedProfile(int[] profile) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (profile == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(profile.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getSelectedProfile, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(profile);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int setProfileSettings(int handle, int profile, DsClientSettings settings) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeInt(profile);
                    if (settings != null) {
                        _data.writeInt(1);
                        settings.writeToParcel(_data, 0);
                    } else {
                        _data.writeInt(0);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_setProfileSettings, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getProfileSettings(int profile, DsClientSettings[] settings) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(profile);
                    if (settings == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(settings.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getProfileSettings, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readTypedArray(settings, DsClientSettings.CREATOR);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int resetProfile(int handle, int profile) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeInt(profile);
                    this.mRemote.transact(Stub.TRANSACTION_resetProfile, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int setProfileName(int handle, int profile, String name) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeInt(profile);
                    _data.writeString(name);
                    this.mRemote.transact(Stub.TRANSACTION_setProfileName, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getDsApVersion(String[] version) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (version == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(version.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getDsApVersion, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readStringArray(version);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getMonoSpeaker(boolean[] isMonoSpeaker) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (isMonoSpeaker == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(isMonoSpeaker.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getMonoSpeaker, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readBooleanArray(isMonoSpeaker);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getDsVersion(String[] version) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    if (version == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(version.length);
                    }
                    this.mRemote.transact(16, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readStringArray(version);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int setIeqPreset(int handle, int profile, int preset) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeInt(profile);
                    _data.writeInt(preset);
                    this.mRemote.transact(17, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getIeqPreset(int profile, int[] preset) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(profile);
                    if (preset == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(preset.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getIeqPreset, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(preset);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getProfileModified(int profile, int[] modifiedValue) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(profile);
                    if (modifiedValue == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(modifiedValue.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getProfileModified, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(modifiedValue);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int setGeq(int handle, int profile, int preset, float[] geqBandGains) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeInt(profile);
                    _data.writeInt(preset);
                    _data.writeFloatArray(geqBandGains);
                    this.mRemote.transact(Stub.TRANSACTION_setGeq, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getGeq(int profile, int preset, float[] geqBandGains) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(profile);
                    _data.writeInt(preset);
                    if (geqBandGains == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(geqBandGains.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getGeq, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readFloatArray(geqBandGains);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int setDsApParam(int handle, String param, int[] values) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    _data.writeString(param);
                    _data.writeIntArray(values);
                    this.mRemote.transact(Stub.TRANSACTION_setDsApParam, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getDsApParam(String param, int[] values) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeString(param);
                    if (values == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(values.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getDsApParam, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(values);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public int getDsApParamLength(String param, int[] len) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeString(param);
                    if (len == null) {
                        _data.writeInt(-1);
                    } else {
                        _data.writeInt(len.length);
                    }
                    this.mRemote.transact(Stub.TRANSACTION_getDsApParamLength, _data, _reply, 0);
                    _reply.readException();
                    int _result = _reply.readInt();
                    _reply.readIntArray(len);
                    return _result;
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public void registerDsApParamEvents(int handle) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    this.mRemote.transact(Stub.TRANSACTION_registerDsApParamEvents, _data, _reply, 0);
                    _reply.readException();
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public void unregisterDsApParamEvents(int handle) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    this.mRemote.transact(Stub.TRANSACTION_unregisterDsApParamEvents, _data, _reply, 0);
                    _reply.readException();
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public void registerCallback(IDsServiceCallbacks cb, int handle) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeStrongBinder(cb != null ? cb.asBinder() : null);
                    _data.writeInt(handle);
                    this.mRemote.transact(Stub.TRANSACTION_registerCallback, _data, _reply, 0);
                    _reply.readException();
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public void unregisterCallback(IDsServiceCallbacks cb) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeStrongBinder(cb != null ? cb.asBinder() : null);
                    this.mRemote.transact(Stub.TRANSACTION_unregisterCallback, _data, _reply, 0);
                    _reply.readException();
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public void registerVisualizerData(int handle) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    this.mRemote.transact(Stub.TRANSACTION_registerVisualizerData, _data, _reply, 0);
                    _reply.readException();
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }

            @Override // android.dolby.IDs
            public void unregisterVisualizerData(int handle) throws RemoteException {
                Parcel _data = Parcel.obtain();
                Parcel _reply = Parcel.obtain();
                try {
                    _data.writeInterfaceToken(Stub.DESCRIPTOR);
                    _data.writeInt(handle);
                    this.mRemote.transact(Stub.TRANSACTION_unregisterVisualizerData, _data, _reply, 0);
                    _reply.readException();
                } finally {
                    _reply.recycle();
                    _data.recycle();
                }
            }
        }
    }
}
