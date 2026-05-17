package android.dolby;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.dolby.IDs;
import android.dolby.IDsServiceCallbacks;
import android.os.DeadObjectException;
import android.os.Handler;
import android.os.IBinder;
import android.os.Message;
import android.os.RemoteException;
import android.util.Log;

/* JADX INFO: loaded from: classes.dex */
public class DsClient {
    private static final String TAG = "DsClient";
    private static Object lock_ = new Object();
    private IDs ds_ = null;
    private IDsClientEvents activityListener_ = null;
    private IDsVisualizerEvents visualizerListener_ = null;
    private IDsApParamEvents dsApParamChangeListener_ = null;
    private int bandCount_ = 0;
    private float[] gains_ = null;
    private float[] excitations_ = null;
    private ServiceConnection connection_ = new ServiceConnection() { // from class: android.dolby.DsClient.1
        @Override // android.content.ServiceConnection
        public void onServiceConnected(ComponentName className, IBinder service) {
            DsLog.log1(DsClient.TAG, "ServiceConnection.onServiceConnected()");
            DsClient.this.ds_ = IDs.Stub.asInterface(service);
            try {
                DsClient.this.ds_.registerCallback(DsClient.this.callbacks_, hashCode());
                Log.i(DsClient.TAG, "hash code of the connect is " + hashCode());
                int[] paramInt = new int[1];
                int error = DsClient.this.ds_.getBandCount(paramInt);
                if (error != 0) {
                    Log.e(DsClient.TAG, "Internal error in onServiceConnected");
                } else {
                    DsClient.this.bandCount_ = paramInt[0];
                }
            } catch (RemoteException e) {
                Log.e(DsClient.TAG, "onServiceConnected failed");
            }
            if (DsClient.this.activityListener_ != null) {
                DsClient.this.activityListener_.onClientConnected();
            }
            DsLog.log3(DsClient.TAG, "CONNECTED: DSService");
        }

        @Override // android.content.ServiceConnection
        public void onServiceDisconnected(ComponentName className) {
            DsLog.log1(DsClient.TAG, "ServiceConnection.onServiceDisconnected()");
            if (DsClient.this.activityListener_ != null) {
                DsClient.this.activityListener_.onClientDisconnected();
            }
            DsClient.this.ds_ = null;
            DsLog.log3(DsClient.TAG, "/ServiceConnection.onServiceDisconnected()");
        }
    };
    private IDsServiceCallbacks callbacks_ = new IDsServiceCallbacks.Stub() { // from class: android.dolby.DsClient.2
        @Override // android.dolby.IDsServiceCallbacks
        public void onDsOn(boolean on) {
            DsLog.log2(DsClient.TAG, "event onDsOn()");
            int status = on ? 1 : 0;
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(1, status, 0));
        }

        @Override // android.dolby.IDsServiceCallbacks
        public void onProfileSelected(int profile) {
            DsLog.log2(DsClient.TAG, "event onProfileSelected()");
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(2, profile, 0));
        }

        @Override // android.dolby.IDsServiceCallbacks
        public void onProfileSettingsChanged(int profile) {
            DsLog.log2(DsClient.TAG, "event onProfileSettingsChanged()");
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(3, profile, 0));
        }

        @Override // android.dolby.IDsServiceCallbacks
        public void onProfileNameChanged(int profile, String name) {
            DsLog.log2(DsClient.TAG, "event onProfileNameChanged()");
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(4, profile, 0, name));
        }

        @Override // android.dolby.IDsServiceCallbacks
        public void onVisualizerUpdated(float[] gains, float[] excitations) {
            DsLog.log3(DsClient.TAG, "event onVisualizerUpdated()");
            System.arraycopy(gains, 0, DsClient.this.gains_, 0, DsClient.this.bandCount_);
            System.arraycopy(excitations, 0, DsClient.this.excitations_, 0, DsClient.this.bandCount_);
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(5, 0, 0));
        }

        @Override // android.dolby.IDsServiceCallbacks
        public void onVisualizerSuspended(boolean isSuspended) {
            DsLog.log2(DsClient.TAG, "event onVisualizerSuspended()");
            int status = isSuspended ? 1 : 0;
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(6, status, 0));
        }

        @Override // android.dolby.IDsServiceCallbacks
        public void onEqSettingsChanged(int profile, int preset) {
            DsLog.log2(DsClient.TAG, "event onEqSettingsChanged()");
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(7, profile, preset));
        }

        @Override // android.dolby.IDsServiceCallbacks
        public void onDsApParamChange(int profile, String paramName) {
            DsLog.log2(DsClient.TAG, "event onDsApParamChange()");
            DsClient.this.handler_.sendMessage(DsClient.this.handler_.obtainMessage(8, profile, 0, paramName));
        }
    };
    private Handler handler_ = new Handler() { // from class: android.dolby.DsClient.3
        @Override // android.os.Handler
        public void handleMessage(Message msg) {
            switch (msg.what) {
                case 1:
                    DsLog.log1(DsClient.TAG, "handleMessage(DS_STATUS_CHANGED_MSG): isOn = " + msg.arg1);
                    boolean isOn = msg.arg1 != 0;
                    if (DsClient.this.activityListener_ != null) {
                        DsClient.this.activityListener_.onDsOn(isOn);
                    }
                    break;
                case 2:
                    DsLog.log1(DsClient.TAG, "handleMessage(PROFILE_SELECTED_MSG): profile = " + msg.arg1);
                    if (DsClient.this.activityListener_ != null) {
                        DsClient.this.activityListener_.onProfileSelected(msg.arg1);
                    }
                    break;
                case 3:
                    DsLog.log1(DsClient.TAG, "handleMessage(PROFILE_SETTINGS_CHANGED_MSG): profile = " + msg.arg1);
                    if (DsClient.this.activityListener_ != null) {
                        DsClient.this.activityListener_.onProfileSettingsChanged(msg.arg1);
                    }
                    break;
                case 4:
                    DsLog.log1(DsClient.TAG, "handleMessage(PROFILE_NAME_CHANGED_MSG): profile = " + msg.arg1 + " name =" + msg.obj);
                    if (DsClient.this.activityListener_ != null) {
                        DsClient.this.activityListener_.onProfileNameChanged(msg.arg1, (String) msg.obj);
                    }
                    break;
                case 5:
                    DsLog.log3(DsClient.TAG, "handleMessage(VISUALIZER_UPDATED_MSG):");
                    if (DsClient.this.visualizerListener_ != null) {
                        DsClient.this.visualizerListener_.onVisualizerUpdate(DsClient.this.excitations_, DsClient.this.gains_);
                    }
                    break;
                case 6:
                    DsLog.log2(DsClient.TAG, "handleMessage(VISUALIZER_SUSPENDED_MSG): isSuspended = " + msg.arg1);
                    if (DsClient.this.visualizerListener_ != null) {
                        boolean isSuspended = msg.arg1 != 0;
                        DsClient.this.visualizerListener_.onVisualizerSuspended(isSuspended);
                    }
                    break;
                case DsCommon.EQ_SETTINGS_CHANGED_MSG /* 7 */:
                    DsLog.log1(DsClient.TAG, "handleMessage(EQ_SETTINGS_CHANGED_MSG): profile = " + msg.arg1 + " preset =" + msg.arg2);
                    if (DsClient.this.activityListener_ != null) {
                        DsClient.this.activityListener_.onEqSettingsChanged(msg.arg1, msg.arg2);
                    }
                    break;
                case DsCommon.DS_PARAM_CHANGED_MSG /* 8 */:
                    DsLog.log1(DsClient.TAG, "handleMessage(DS_PARAM_CHANGED_MSG): profile " + msg.arg1 + ", parameter = " + msg.obj);
                    if (DsClient.this.dsApParamChangeListener_ != null) {
                        DsClient.this.dsApParamChangeListener_.onDsApParamChange(msg.arg1, (String) msg.obj);
                    }
                    break;
                default:
                    super.handleMessage(msg);
                    break;
            }
        }
    };

    private void translateErrorCodeToExceptions(int errorCode) throws RuntimeException, DeadObjectException {
        if (errorCode >= 0) {
            return;
        }
        switch (errorCode) {
            case DsCommon.DS_OPERATION_NOT_PERMITTED /* -4 */:
                throw new UnsupportedOperationException();
            case DsCommon.DS_INVALID_STATE /* -3 */:
                throw new IllegalStateException();
            case DsCommon.DS_NOT_RUNNING /* -2 */:
                throw new DeadObjectException();
            case DsCommon.DS_INVALID_ARGUMENT /* -1 */:
                throw new IllegalArgumentException();
            default:
                throw new RuntimeException();
        }
    }

    public void setDsOn(boolean on) throws RemoteException, RuntimeException {
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    try {
                        int error = this.ds_.setDsOn(this.connection_.hashCode(), on);
                        translateErrorCodeToExceptions(error);
                    } catch (NullPointerException e) {
                        Log.e(TAG, "NullPointerException in setDsOn");
                        e.printStackTrace();
                        throw e;
                    }
                } catch (RemoteException e2) {
                    Log.e(TAG, "RemoteException in setDsOn");
                    throw e2;
                } catch (Exception e3) {
                    Log.e(TAG, e3.toString() + " in setDsOn");
                    e3.printStackTrace();
                    throw new RuntimeException("Exception in setDsOn");
                }
            }
        }
    }

    public int setDsOnChecked(boolean on) throws RemoteException, RuntimeException {
        int error = 1;
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    try {
                        try {
                            error = this.ds_.setDsOn(this.connection_.hashCode(), on);
                            translateErrorCodeToExceptions(error);
                        } catch (RemoteException e) {
                            Log.e(TAG, "RemoteException in setDsOnChecked");
                            throw e;
                        }
                    } catch (NullPointerException e2) {
                        Log.e(TAG, "NullPointerException in setDsOnChecked");
                        e2.printStackTrace();
                        throw e2;
                    }
                } catch (Exception e3) {
                    Log.e(TAG, e3.toString() + " in setDsOnChecked");
                    e3.printStackTrace();
                    throw new RuntimeException("Exception in setDsOnChecked");
                }
            }
        }
        return error;
    }

    public boolean getDsOn() throws RemoteException, RuntimeException {
        boolean value = false;
        if (this.ds_ != null) {
            try {
                boolean[] paramBoolean = new boolean[1];
                int error = this.ds_.getDsOn(paramBoolean);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    value = paramBoolean[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getDsOn");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getDsOn");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getDsOn");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getDsOn");
            }
        }
        return value;
    }

    public void setNonPersistentMode(boolean on) throws RemoteException, RuntimeException {
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    int error = this.ds_.setNonPersistentMode(on);
                    if (error != 0) {
                        translateErrorCodeToExceptions(error);
                    }
                } catch (RemoteException e) {
                    Log.e(TAG, "RemoteException in setNonPersistentMode");
                    throw e;
                } catch (NullPointerException e2) {
                    Log.e(TAG, "NullPointerException in setNonPersistentMode");
                    e2.printStackTrace();
                    throw e2;
                } catch (Exception e3) {
                    Log.e(TAG, e3.toString() + " in setNonPersistentMode");
                    e3.printStackTrace();
                    throw new RuntimeException("Exception in setNonPersistentMode");
                }
            }
        }
    }

    public int getProfileCount() throws RemoteException, RuntimeException {
        int value = 0;
        if (this.ds_ != null) {
            try {
                int[] paramInt = new int[1];
                int error = this.ds_.getProfileCount(paramInt);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    value = paramInt[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getProfileCount");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getProfileCount");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getProfileCount");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getProfileCount");
            }
        }
        return value;
    }

    public String[] getProfileNames() throws RemoteException, RuntimeException {
        String[] names = null;
        if (this.ds_ != null) {
            try {
                names = new String[getProfileCount()];
                int error = this.ds_.getProfileNames(names);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getProfileNames");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getProfileNames");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getProfileNames");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getProfileNames");
            }
        }
        return names;
    }

    public int getBandCount() throws RemoteException, RuntimeException {
        int value = 0;
        if (this.ds_ != null) {
            try {
                int[] paramInt = new int[1];
                int error = this.ds_.getBandCount(paramInt);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    value = paramInt[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getBandCount");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getBandCount");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getBandCount");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getBandCount");
            }
        }
        return value;
    }

    public int[] getBandFrequencies() throws RemoteException, RuntimeException {
        int[] bandFrequencies = null;
        if (this.ds_ != null) {
            try {
                bandFrequencies = new int[getBandCount()];
                int error = this.ds_.getBandFrequencies(bandFrequencies);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getBandFrequencies");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getBandFrequencies");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getBandFrequencies");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getBandFrequencies");
            }
        }
        return bandFrequencies;
    }

    public void setSelectedProfile(int profile) throws RemoteException, RuntimeException {
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    try {
                        try {
                            int error = this.ds_.setSelectedProfile(this.connection_.hashCode(), profile);
                            if (error != 0) {
                                translateErrorCodeToExceptions(error);
                            }
                        } catch (Exception e) {
                            Log.e(TAG, e.toString() + " in setSelectedProfile");
                            e.printStackTrace();
                            throw new RuntimeException("Exception in setSelectedProfile");
                        }
                    } catch (NullPointerException e2) {
                        Log.e(TAG, "NullPointerException in setSelectedProfile");
                        e2.printStackTrace();
                        throw e2;
                    }
                } catch (RemoteException e3) {
                    Log.e(TAG, "RemoteException in setSelectedProfile");
                    throw e3;
                }
            }
        }
    }

    public int getSelectedProfile() throws RemoteException, RuntimeException {
        int value = 0;
        if (this.ds_ != null) {
            try {
                int[] paramInt = new int[1];
                int error = this.ds_.getSelectedProfile(paramInt);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    value = paramInt[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getSelectedProfile");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getSelectedProfile");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getSelectedProfile");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getSelectedProfile");
            }
        }
        return value;
    }

    public void setProfileSettings(int profile, DsClientSettings settings) throws RemoteException, RuntimeException {
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (settings == null) {
            throw new IllegalArgumentException("invalid settings");
        }
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    int error = this.ds_.setProfileSettings(this.connection_.hashCode(), profile, settings);
                    if (error != 0) {
                        translateErrorCodeToExceptions(error);
                    }
                } catch (RemoteException e) {
                    Log.e(TAG, "RemoteException in setProfileSettings");
                    throw e;
                } catch (NullPointerException e2) {
                    Log.e(TAG, "NullPointerException in setProfileSettings");
                    e2.printStackTrace();
                    throw e2;
                } catch (Exception e3) {
                    Log.e(TAG, e3.toString() + " in setProfileSettings");
                    e3.printStackTrace();
                    throw new RuntimeException("Exception in setProfileSettings");
                }
            }
        }
    }

    public DsClientSettings getProfileSettings(int profile) throws RemoteException, RuntimeException {
        if (this.ds_ == null) {
            return null;
        }
        try {
            DsClientSettings[] paramSettings = new DsClientSettings[1];
            int error = this.ds_.getProfileSettings(profile, paramSettings);
            if (error != 0) {
                translateErrorCodeToExceptions(error);
            }
            DsClientSettings settings = paramSettings[0];
            return settings;
        } catch (RemoteException e) {
            Log.e(TAG, "RemoteException in getProfileSettings");
            throw e;
        } catch (NullPointerException e2) {
            Log.e(TAG, "NullPointerException in getProfileSettings");
            e2.printStackTrace();
            throw e2;
        } catch (Exception e3) {
            Log.e(TAG, e3.toString() + " in getProfileSetting");
            e3.printStackTrace();
            throw new RuntimeException("Exception in getProfileSettings");
        }
    }

    public void resetProfile(int profile) throws RemoteException, RuntimeException {
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    try {
                        try {
                            int error = this.ds_.resetProfile(this.connection_.hashCode(), profile);
                            if (error != 0) {
                                translateErrorCodeToExceptions(error);
                            }
                        } catch (Exception e) {
                            Log.e(TAG, e.toString() + " in resetProfile");
                            e.printStackTrace();
                            throw new RuntimeException("Exception in resetProfile");
                        }
                    } catch (NullPointerException e2) {
                        Log.e(TAG, "NullPointerException in resetProfile");
                        e2.printStackTrace();
                        throw e2;
                    }
                } catch (RemoteException e3) {
                    Log.e(TAG, "RemoteException in resetProfile");
                    throw e3;
                }
            }
        }
    }

    public void setProfileName(int profile, String name) throws RemoteException, RuntimeException {
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (name == null) {
            throw new IllegalArgumentException("invalid name");
        }
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    int error = this.ds_.setProfileName(this.connection_.hashCode(), profile, name);
                    if (error != 0) {
                        translateErrorCodeToExceptions(error);
                    }
                } catch (RemoteException e) {
                    Log.e(TAG, "RemoteException in setProfileName");
                    throw e;
                } catch (NullPointerException e2) {
                    Log.e(TAG, "NullPointerException in setProfileName");
                    e2.printStackTrace();
                    throw e2;
                } catch (Exception e3) {
                    Log.e(TAG, e3.toString() + " in setProfileName");
                    e3.printStackTrace();
                    throw new RuntimeException("Exception in setProfileName");
                }
            }
        }
    }

    public String getDsApVersion() throws RemoteException, RuntimeException {
        String version = "";
        if (this.ds_ != null) {
            try {
                String[] paramString = new String[1];
                int error = this.ds_.getDsApVersion(paramString);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    version = paramString[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getDsApVersion");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getDsApVersion");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getDsApVersion");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getDsApVersion");
            }
        }
        return version;
    }

    public String getDsVersion() throws RemoteException, RuntimeException {
        String version = "";
        if (this.ds_ != null) {
            try {
                String[] paramString = new String[1];
                int error = this.ds_.getDsVersion(paramString);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    version = paramString[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getDsVersion");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getDsVersion");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getDsVersion");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getDsVersion");
            }
        }
        return version;
    }

    public boolean isMonoSpeaker() throws RemoteException, RuntimeException {
        boolean ret_val = false;
        if (this.ds_ != null) {
            try {
                boolean[] paramBoolean = new boolean[1];
                int error = this.ds_.getMonoSpeaker(paramBoolean);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    ret_val = paramBoolean[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in isMonoSpeaker");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException isMonoSpeaker");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in isMonoSpeaker");
                e3.printStackTrace();
                throw new RuntimeException("Exception in isMonoSpeaker");
            }
        }
        return ret_val;
    }

    public void setIeqPreset(int profile, int preset) throws RemoteException, RuntimeException {
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (preset < 0 || preset > 3) {
            throw new IllegalArgumentException("invalid preset");
        }
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    try {
                        int error = this.ds_.setIeqPreset(this.connection_.hashCode(), profile, preset);
                        if (error != 0) {
                            translateErrorCodeToExceptions(error);
                        }
                    } catch (RemoteException e) {
                        Log.e(TAG, "RemoteException in setIeqPreset");
                        throw e;
                    }
                } catch (NullPointerException e2) {
                    Log.e(TAG, "NullPointerException in setIeqPreset");
                    e2.printStackTrace();
                    throw e2;
                } catch (Exception e3) {
                    Log.e(TAG, e3.toString() + " in setIeqPreset");
                    e3.printStackTrace();
                    throw new RuntimeException("Exception in setIeqPreset");
                }
            }
        }
    }

    public int getIeqPreset(int profile) throws RemoteException, RuntimeException {
        int value = 0;
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (this.ds_ != null) {
            try {
                int[] paramInt = new int[1];
                int error = this.ds_.getIeqPreset(profile, paramInt);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    value = paramInt[0];
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getIeqPreset");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getIeqPreset");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getIeqPreset");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getIeqPreset");
            }
        }
        return value;
    }

    public boolean isProfileModified(int profile) throws RemoteException, RuntimeException {
        boolean value = false;
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (this.ds_ != null) {
            try {
                int[] paramInt = new int[1];
                int error = this.ds_.getProfileModified(profile, paramInt);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    value = (paramInt[0] & 1) == 1;
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in isProfileModified");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException isProfileModified");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in isProfileModified");
                e3.printStackTrace();
                throw new RuntimeException("Exception in isProfileModified");
            }
        }
        return value;
    }

    public boolean isProfileNameModified(int profile) throws RemoteException, RuntimeException {
        boolean value = false;
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (this.ds_ != null) {
            try {
                int[] paramInt = new int[1];
                int error = this.ds_.getProfileModified(profile, paramInt);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                } else {
                    value = (paramInt[0] & 2) == 2;
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in isProfileNameModified");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException isProfileNameModified");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in isProfileNameModified");
                e3.printStackTrace();
                throw new RuntimeException("Exception in isProfileNameModified");
            }
        }
        return value;
    }

    public void setGeq(int profile, int preset, float[] geqBandGains) throws RemoteException, RuntimeException {
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (preset < 0 || preset > 3) {
            throw new IllegalArgumentException("invalid preset");
        }
        if (this.ds_ != null) {
            synchronized (lock_) {
                try {
                    try {
                        int error = this.ds_.setGeq(this.connection_.hashCode(), profile, preset, geqBandGains);
                        if (error != 0) {
                            translateErrorCodeToExceptions(error);
                        }
                    } catch (RemoteException e) {
                        Log.e(TAG, "RemoteException in setGeq");
                        throw e;
                    }
                } catch (NullPointerException e2) {
                    Log.e(TAG, "NullPointerException in setGeq");
                    e2.printStackTrace();
                    throw e2;
                } catch (Exception e3) {
                    Log.e(TAG, e3.toString() + " in setGeq");
                    e3.printStackTrace();
                    throw new RuntimeException("Exception in setGeq");
                }
            }
        }
    }

    public float[] getGeq(int profile, int preset) throws RemoteException, RuntimeException {
        float[] value = null;
        if (profile < 0 || profile > 5) {
            throw new IllegalArgumentException("invalid profile");
        }
        if (preset < 0 || preset > 3) {
            throw new IllegalArgumentException("invalid preset");
        }
        if (this.ds_ != null) {
            try {
                value = new float[getBandCount()];
                int error = this.ds_.getGeq(profile, preset, value);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getGeq");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getGeq");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getGeq");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getGeq");
            }
        }
        return value;
    }

    public void setDsApParam(String param, int[] values) throws RemoteException, RuntimeException {
        if (this.ds_ != null) {
            try {
                int error = this.ds_.setDsApParam(this.connection_.hashCode(), param, values);
                if (error != 0) {
                    translateErrorCodeToExceptions(error);
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in setDsApParam");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in setDsApParam");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in setDsApParam");
                e3.printStackTrace();
                throw new RuntimeException("Exception in setDsApParam");
            }
        }
    }

    public int[] getDsApParam(String param) throws RemoteException, RuntimeException {
        int error;
        int[] values = null;
        if (this.ds_ != null) {
            try {
                int[] paramInt = new int[1];
                if (this.ds_.getDsApParamLength(param, paramInt) == 0 && (error = this.ds_.getDsApParam(param, (values = new int[paramInt[0]]))) != 0) {
                    translateErrorCodeToExceptions(error);
                }
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in getDsApParam");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in getDsApParam");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in getDsApParam");
                e3.printStackTrace();
                throw new RuntimeException("Exception in getDsApParam");
            }
        }
        return values;
    }

    public void registerDsApParamEvents(IDsApParamEvents listener) throws RemoteException, RuntimeException {
        if (this.ds_ != null) {
            try {
                this.ds_.registerDsApParamEvents(this.connection_.hashCode());
                this.dsApParamChangeListener_ = listener;
                return;
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in registerDsApParamEvents");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in registerDsApParamEvents");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in registerDsApParamEvents");
                e3.printStackTrace();
                throw new RuntimeException("Exception in registerDsApParamEvents");
            }
        }
        throw new RuntimeException("registerDsApParamEvents failed");
    }

    public void unregisterDsApParamEvents() throws RemoteException, RuntimeException {
        if (this.ds_ != null) {
            try {
                this.ds_.unregisterDsApParamEvents(this.connection_.hashCode());
                this.dsApParamChangeListener_ = null;
                return;
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in unregisterDsApParamEvents");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in unregisterDsApParamEvents");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in unregisterDsApParamEvents");
                e3.printStackTrace();
                throw new RuntimeException("Exception in unregisterDsApParamEvents");
            }
        }
        throw new RuntimeException("unregisterDsApParamEvents failed");
    }

    public void registerVisualizer(IDsVisualizerEvents listener) throws RemoteException, RuntimeException {
        if (this.ds_ != null) {
            try {
                if (this.bandCount_ == 0) {
                    Log.e(TAG, "graphic equalizer band count NOT initialized yet.");
                    throw new RuntimeException("Exception in registerVisualizer");
                }
                if (this.gains_ == null) {
                    this.gains_ = new float[this.bandCount_];
                }
                if (this.excitations_ == null) {
                    this.excitations_ = new float[this.bandCount_];
                }
                this.ds_.registerVisualizerData(this.connection_.hashCode());
                this.visualizerListener_ = listener;
                return;
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in registerVisualizer");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in registerVisualizer");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in registerVisualizer");
                e3.printStackTrace();
                throw new RuntimeException("Exception in registerVisualizer");
            }
        }
        throw new RuntimeException("registerVisualizer failed");
    }

    public void unregisterVisualizer() throws RemoteException, RuntimeException {
        if (this.ds_ != null) {
            try {
                this.ds_.unregisterVisualizerData(this.connection_.hashCode());
                this.visualizerListener_ = null;
                return;
            } catch (RemoteException e) {
                Log.e(TAG, "RemoteException in unregisterVisualizer");
                throw e;
            } catch (NullPointerException e2) {
                Log.e(TAG, "NullPointerException in unregisterVisualizer");
                e2.printStackTrace();
                throw e2;
            } catch (Exception e3) {
                Log.e(TAG, e3.toString() + " in unregisterVisualizer");
                e3.printStackTrace();
                throw new RuntimeException("Exception in unregisterVisualizer");
            }
        }
        throw new RuntimeException("unregisterVisualizer failed");
    }

    public static float getGeqBandGainLowerBound() {
        return DsConstants.GEQ_BAND_GAIN_RANGE[0];
    }

    public static float getGeqBandGainUpperBound() {
        return DsConstants.GEQ_BAND_GAIN_RANGE[1];
    }

    public void setEventListener(IDsClientEvents listener) {
        if (listener != null) {
            this.activityListener_ = listener;
        }
    }

    public boolean bindDsService(Context context) {
        DsLog.log1(TAG, "bindDsService()");
        Intent bindIntent = new Intent(IDs.class.getName());
        return context.bindService(bindIntent, this.connection_, 1);
    }

    public void unBindDsService(Context context) {
        DsLog.log1(TAG, "unBindDsService()");
        try {
            this.ds_.unregisterVisualizerData(this.connection_.hashCode());
            this.visualizerListener_ = null;
            this.ds_.unregisterDsApParamEvents(this.connection_.hashCode());
            this.dsApParamChangeListener_ = null;
            this.ds_.unregisterCallback(this.callbacks_);
        } catch (RemoteException e) {
            Log.e(TAG, "Remote Exception in unBindFromRemoteRunningService");
        }
        context.unbindService(this.connection_);
    }
}
