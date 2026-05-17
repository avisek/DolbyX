package com.dolby;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.dolby.DsClientSettings;
import android.dolby.DsCommon;
import android.dolby.DsLog;
import android.dolby.IDs;
import android.dolby.IDsServiceCallbacks;
import android.dolby.ds.Ds;
import android.dolby.ds.DsAkSettings;
import android.os.DeadObjectException;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Message;
import android.os.RemoteCallbackList;
import android.os.RemoteException;
import android.os.SystemProperties;
import android.util.Log;
import android.widget.Toast;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/* JADX INFO: loaded from: classes.dex */
public class DsService extends Service {
    private static final String ACTION_DOLBY_LAUNCH_APP = "com.dolby.LAUNCH_DS_APP";
    private static final int COUNTER_THRESHOLD = 10;
    private static final String DS_DEFAULT_SETTINGS_FILENAME = "ds1-default.xml";
    private static final String DS_DEFAULT_SETTINGS_USER_PATH = "/system/etc";
    private static final int DS_EFFECT_SUSPENDED = 1;
    private static final String DS_EFFECT_SUSPEND_ACTION = "DS_EFFECT_SUSPEND_ACTION";
    private static final int DS_EFFECT_UNSUSPENDED = 0;
    private static final int GLOBAL_AUDIO_SESSION_ID = 0;
    private static final int INT_OFF = 0;
    private static final int INT_ON = 1;
    private static final String LPA_SESSION_ID_CHANGED_ACTION = "LPA_SESSION_ID_CHANGED_ACTION";
    private static final String LPA_SESSION_ID_REMOVED_ACTION = "LPA_SESSION_ID_REMOVED_ACTION";
    private static final String PROP_DS_DIALOGENHANCER_STATE = "dolby.ds.dialogenhancer.state";
    private static final String PROP_DS_GEQ_STATE = "dolby.ds.graphiceq.state";
    private static final String PROP_DS_HEADPHONE_VIRTUALIZER_STATE = "dolby.ds.hpvirtualizer.state";
    private static final String PROP_DS_IEQ_PRESET = "dolby.ds.intelligenteq.preset";
    private static final String PROP_DS_IEQ_STATE = "dolby.ds.intelligenteq.state";
    private static final String PROP_DS_PROFILE_NAME = "dolby.ds.profile.name";
    private static final String PROP_DS_SPEAKER_VIRTUALIZER_STATE = "dolby.ds.spkvirtualizer.state";
    private static final String PROP_DS_STATE = "dolby.ds.state";
    private static final String PROP_DS_VOLUMELEVELER_STATE = "dolby.ds.volumeleveler.state";
    private static final String PROP_MONO_SPEAKER = "dolby.monospeaker";
    private static final String STATE_OFF = "off";
    private static final String STATE_ON = "on";
    private static final String TAG = "DsService";
    private static final int VISUALIZER_UPDATE_TIME = 50;
    private static final int ZERO_HANDLE = 0;
    private static final boolean isDefaultSettingsOnFileSystem = true;
    private Handler visualizerHandler_;
    private HandlerThread visualizerThread_;
    private DsClientSettings lastSettings_ = null;
    private Ds ds_ = null;
    private boolean nonPersistentMode_ = false;
    private final Object lockDolbyContext_ = new Object();
    private final Object lockCallbacks_ = new Object();
    private final RemoteCallbackList<IDsServiceCallbacks> callbacks_ = new RemoteCallbackList<>();
    private ArrayList<Integer> visualizerList_ = new ArrayList<>();
    private ArrayList<Integer> dsApParamEventList_ = new ArrayList<>();
    private boolean isDsEffectSuspended = false;
    private boolean isDsOnWhileSuspend = false;
    private ArrayList<IDolbyWidgetUpdateStatus> appWidgetList_ = new ArrayList<>();
    private int geqBandCount_ = 0;
    private float[] gains_ = null;
    private float[] excitations_ = null;
    private boolean isVisualizerSuspended_ = false;
    private int noVisualizerCounter_ = 0;
    private int previousVisualizerSize_ = 0;
    private final Runnable cbkOnVisualizerUpdate_ = new Runnable() { // from class: com.dolby.DsService.1
        @Override // java.lang.Runnable
        public void run() {
            DsService.this.visualizerUpdate();
        }
    };
    private BroadcastReceiver intentReceiver_ = new BroadcastReceiver() { // from class: com.dolby.DsService.2
        @Override // android.content.BroadcastReceiver
        public void onReceive(Context context, Intent intent) {
            try {
                synchronized (DsService.this.lockDolbyContext_) {
                    String action = intent.getAction();
                    String cmd = intent.getStringExtra(DsCommon.CMDNAME);
                    String name = intent.getStringExtra(DsCommon.WIDGET_CLASS);
                    DsLog.log1(DsService.TAG, "intentReceiver_.onReceive " + action + " / " + cmd + " / " + name);
                    if (DsCommon.INIT_ACTION.equals(action)) {
                        if (name != null) {
                            if (name.equals("com.dolby.ds.DolbyWidgetSmallProvider")) {
                                DsService.this.appWidgetList_.add(DolbyWidgetSmallProvider.getInstance());
                            } else if (name.equals("com.dolby.ds.DolbyWidgetExtraLargeProvider")) {
                                DsService.this.appWidgetList_.add(DolbyWidgetExtraLargeProvider.getInstance());
                            }
                        }
                        DsService.this.notifyWidget();
                    } else if ((intent.getAction().equals("android.intent.action.REBOOT") || intent.getAction().equals("android.intent.action.ACTION_SHUTDOWN")) && DsService.this.ds_ != null) {
                        DsLog.log1(DsService.TAG, "Save DS state and current settings before shutting down...");
                        if (!DsService.this.nonPersistentMode_) {
                            DsService.this.ds_.saveDsStateAndSettings();
                        }
                    } else if (action.equals("media_server_started")) {
                        DsService.this.ds_.validateDsEffect();
                        DsLog.log1(DsService.TAG, "DS effect recreate successfully");
                    } else if (action.equals(DsService.LPA_SESSION_ID_CHANGED_ACTION)) {
                        DsLog.log1(DsService.TAG, "DOLBY_DAP_OPENSLES_LPA: Respond to LPA_SESSION_ID_CHANGED_ACTION");
                        if (DsService.this.ds_.validateDsEffect()) {
                            int audioSessionId = getResultCode();
                            Log.d(DsService.TAG, "createDsLpa(" + audioSessionId + ")");
                            DsService.this.ds_.createDsLpaEffect(audioSessionId);
                        }
                    } else if (action.equals(DsService.LPA_SESSION_ID_REMOVED_ACTION)) {
                        DsLog.log1(DsService.TAG, "DOLBY_DAP_OPENSLES_LPA: Respond to LPA_SESSION_ID_REMOVED_ACTION");
                        if (DsService.this.ds_.validateDsEffect() && DsService.this.ds_.getLpaAudioSessionId() == getResultCode()) {
                            DsService.this.ds_.destroyDsLpaEffect();
                            if (DsService.this.isDsEffectSuspended) {
                                String dsState = SystemProperties.get(DsService.PROP_DS_STATE);
                                if (dsState.equals(DsService.STATE_ON)) {
                                    DsService.this.isDsOnWhileSuspend = DsService.isDefaultSettingsOnFileSystem;
                                    DsService.this.doSetDsOn(0, false);
                                }
                            }
                        }
                    } else if (action.equals(DsService.DS_EFFECT_SUSPEND_ACTION)) {
                        DsLog.log1(DsService.TAG, "DS_EFFECT_SUSPEND_ACTION " + getResultCode());
                        switch (getResultCode()) {
                            case 0:
                                DsService.this.isDsEffectSuspended = false;
                                if (DsService.this.isDsOnWhileSuspend) {
                                    DsLog.log1(DsService.TAG, "DS_EFFECT_SUSPEND_ACTION UI ON");
                                    DsService.this.isDsOnWhileSuspend = false;
                                    DsService.this.doSetDsOn(0, DsService.isDefaultSettingsOnFileSystem);
                                }
                                break;
                            case 1:
                                DsService.this.isDsEffectSuspended = DsService.isDefaultSettingsOnFileSystem;
                                if (!DsService.this.ds_.isLpaActive()) {
                                    String dsState2 = SystemProperties.get(DsService.PROP_DS_STATE);
                                    if (dsState2.equals(DsService.STATE_ON)) {
                                        DsLog.log1(DsService.TAG, "DS_EFFECT_SUSPEND_ACTION UI OFF");
                                        DsService.this.isDsOnWhileSuspend = DsService.isDefaultSettingsOnFileSystem;
                                        DsService.this.doSetDsOn(0, false);
                                    }
                                }
                                break;
                        }
                    }
                }
            } catch (RuntimeException ex) {
                throw ex;
            } catch (Exception ex2) {
                Log.e(DsService.TAG, "Exception found in DsService::onReceive()");
                ex2.printStackTrace();
            }
        }
    };
    private final IDs.Stub binder_ = new IDs.Stub() { // from class: com.dolby.DsService.3
        @Override // android.dolby.IDs
        public int getDsOn(boolean[] on) {
            DsLog.log1(DsService.TAG, "IDs.getDsOn()");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                if (on != null) {
                    try {
                        on[0] = DsService.this.ds_.getDsOn();
                        error = 0;
                    } catch (DeadObjectException e) {
                        Log.e(DsService.TAG, "DeadObjectException in getDsOn");
                        e.printStackTrace();
                        error = -2;
                    } catch (Exception e2) {
                        Log.e(DsService.TAG, "Exception in getDsOn");
                        e2.printStackTrace();
                    }
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int setDsOn(int handle, boolean on) {
            DsLog.log1(DsService.TAG, "IDs.setDsOn(" + on + ")");
            try {
                int error = DsService.this.doSetDsOn(handle, on);
                return error;
            } catch (DeadObjectException e) {
                Log.e(DsService.TAG, "DeadObjectException in setDsOn");
                e.printStackTrace();
                return -2;
            } catch (Exception e2) {
                Log.e(DsService.TAG, "Exception in setDsOn");
                e2.printStackTrace();
                return -5;
            }
        }

        @Override // android.dolby.IDs
        public int setNonPersistentMode(boolean on) {
            DsLog.log1(DsService.TAG, "IDs.setNonPersistentMode(" + on + ")");
            int error = 0;
            synchronized (DsService.this.lockDolbyContext_) {
                if (on) {
                    if (!DsService.this.nonPersistentMode_) {
                        DsService.this.ds_.saveDsStateAndSettings();
                        DsService.this.nonPersistentMode_ = on;
                    } else {
                        DsLog.log1(DsService.TAG, "nonPersistentMode_ already set");
                        return 0;
                    }
                } else if (DsService.this.nonPersistentMode_) {
                    try {
                        if (DsService.this.loadSettings("/system/etc/ds1-default.xml")) {
                            DsService.this.ds_.restoreCurrentProfiles();
                            int profile = DsService.this.ds_.getSelectedProfile();
                            String curState = DsService.this.ds_.getDsOn() ? DsService.STATE_ON : DsService.STATE_OFF;
                            SystemProperties.set(DsService.PROP_DS_STATE, curState);
                            DsService.this.setProfileProperties(profile);
                            DsService.this.sendAllEventsToClients();
                            DsService.this.nonPersistentMode_ = on;
                        } else {
                            Log.e(DsService.TAG, "loadSettings FAILED! DS settings are NOT loaded successfully.");
                            error = -3;
                        }
                    } catch (Exception e) {
                        Log.e(DsService.TAG, "Exception in setDsOn");
                        e.printStackTrace();
                        error = -5;
                    }
                }
                return error;
            }
        }

        @Override // android.dolby.IDs
        public int getProfileCount(int[] count) {
            int error;
            DsLog.log1(DsService.TAG, "IDs.getProfileCount()");
            synchronized (DsService.this.lockDolbyContext_) {
                if (count != null) {
                    count[0] = DsService.this.ds_.getProfileCount();
                    error = 0;
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getProfileNames(String[] names) {
            DsLog.log1(DsService.TAG, "IDs.getProfileNames");
            synchronized (DsService.this.lockDolbyContext_) {
                String[] realNames = DsService.this.ds_.getProfileNames();
                System.arraycopy(realNames, 0, names, 0, realNames.length);
            }
            return 0;
        }

        @Override // android.dolby.IDs
        public int getBandCount(int[] count) {
            int error;
            DsLog.log1(DsService.TAG, "IDs.getBandCount");
            synchronized (DsService.this.lockDolbyContext_) {
                if (count != null) {
                    count[0] = DsAkSettings.getGeqBandCount();
                    error = 0;
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getBandFrequencies(int[] frequencies) {
            DsLog.log1(DsService.TAG, "IDs.getBandFrequencies");
            synchronized (DsService.this.lockDolbyContext_) {
                int[] realFrequencies = DsAkSettings.getGeqBandFrequencies();
                System.arraycopy(realFrequencies, 0, frequencies, 0, realFrequencies.length);
            }
            return 0;
        }

        @Override // android.dolby.IDs
        public int setSelectedProfile(int handle, int profile) {
            DsLog.log1(DsService.TAG, "IDs.setSelectedProfile(" + profile + ")");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                    try {
                        boolean success = DsService.this.doSetSelectedProfile(handle, profile);
                        if (success) {
                            error = 0;
                        }
                    } catch (IllegalArgumentException e) {
                        Log.e(DsService.TAG, "IllegalArgumentException in setSelectedProfile");
                        e.printStackTrace();
                        error = -1;
                    }
                } catch (DeadObjectException e2) {
                    Log.e(DsService.TAG, "DeadObjectException in setSelectedProfile");
                    e2.printStackTrace();
                    error = -2;
                } catch (Exception e3) {
                    Log.e(DsService.TAG, "Exception in setSelectedProfile");
                    e3.printStackTrace();
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getSelectedProfile(int[] profile) {
            int error;
            DsLog.log1(DsService.TAG, "IDs.getSelectedProfile");
            synchronized (DsService.this.lockDolbyContext_) {
                if (profile != null) {
                    profile[0] = DsService.this.ds_.getSelectedProfile();
                    error = 0;
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int setProfileSettings(int handle, int profile, DsClientSettings settings) {
            DsLog.log1(DsService.TAG, "IDs.setProfileSettings(" + profile + ")");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                    try {
                        try {
                        } catch (DeadObjectException e) {
                            Log.e(DsService.TAG, "DeadObjectException in setProfileSettings");
                            e.printStackTrace();
                            error = -2;
                        }
                    } catch (IllegalArgumentException e2) {
                        Log.e(DsService.TAG, "IllegalArgumentException in setProfileSettings");
                        e2.printStackTrace();
                        error = -1;
                    }
                } catch (Exception e3) {
                    Log.e(DsService.TAG, "Exception in setProfileSettings");
                    e3.printStackTrace();
                }
                if (DsService.this.ds_.setProfileSettings(profile, settings)) {
                    if (profile == DsService.this.ds_.getSelectedProfile()) {
                        DsService.this.setProfileProperties(profile);
                    }
                    Message msg = new Message();
                    msg.what = 3;
                    msg.arg1 = handle;
                    msg.arg2 = profile;
                    DsService.this.mHandler.sendMessage(msg);
                    error = 0;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getProfileSettings(int profile, DsClientSettings[] settings) {
            DsLog.log1(DsService.TAG, "IDs.getProfileSettings(" + profile + ")");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                if (settings != null) {
                    try {
                        try {
                            DsClientSettings realSettings = DsService.this.ds_.getProfileSettings(profile);
                            settings[0] = realSettings;
                            error = 0;
                        } catch (Exception e) {
                            Log.e(DsService.TAG, "Exception in getProfileSettings");
                            e.printStackTrace();
                        }
                    } catch (IllegalArgumentException e2) {
                        Log.e(DsService.TAG, "IllegalArgumentException in getProfileSettings");
                        e2.printStackTrace();
                        error = -1;
                    }
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int resetProfile(int handle, int profile) {
            DsLog.log1(DsService.TAG, "IDs.resetProfile");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                    try {
                        try {
                            try {
                            } catch (IllegalArgumentException e) {
                                Log.e(DsService.TAG, "IllegalArgumentException in resetProfile");
                                e.printStackTrace();
                                error = -1;
                            }
                        } catch (Exception e2) {
                            Log.e(DsService.TAG, "Exception in resetProfile");
                            e2.printStackTrace();
                        }
                    } catch (UnsupportedOperationException e3) {
                        Log.e(DsService.TAG, "UnsupportedOperationException in resetProfile");
                        e3.printStackTrace();
                        error = -4;
                    }
                } catch (DeadObjectException e4) {
                    Log.e(DsService.TAG, "DeadObjectException in resetProfile");
                    e4.printStackTrace();
                }
                if (DsService.this.ds_.resetProfile(profile)) {
                    if (profile == DsService.this.ds_.getSelectedProfile()) {
                        DsService.this.setProfileProperties(profile);
                    }
                    Message msg = new Message();
                    msg.what = 3;
                    msg.arg1 = handle;
                    msg.arg2 = profile;
                    DsService.this.mHandler.sendMessage(msg);
                    if (profile >= 4) {
                        String[] names = DsService.this.ds_.getProfileNames();
                        Message msg2 = new Message();
                        msg2.what = 4;
                        msg2.arg1 = handle;
                        msg2.arg2 = profile;
                        msg2.obj = new String(names[profile]);
                        DsService.this.mHandler.sendMessage(msg2);
                    }
                    DsService.this.notifyWidget();
                    error = 0;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int setProfileName(int handle, int profile, String name) {
            DsLog.log1(DsService.TAG, "IDs.setProfileName");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                    try {
                        try {
                        } catch (IllegalArgumentException e) {
                            Log.e(DsService.TAG, "IllegalArgumentException in setProfileName");
                            e.printStackTrace();
                            error = -1;
                        }
                    } catch (Exception e2) {
                        Log.e(DsService.TAG, "Exception in setProfileName");
                        e2.printStackTrace();
                    }
                } catch (UnsupportedOperationException e3) {
                    Log.e(DsService.TAG, "UnsupportedOperationException in setProfileName");
                    e3.printStackTrace();
                    error = -4;
                }
                if (DsService.this.ds_.setProfileName(profile, name)) {
                    Message msg = new Message();
                    msg.what = 4;
                    msg.arg1 = handle;
                    msg.arg2 = profile;
                    msg.obj = new String(name);
                    DsService.this.mHandler.sendMessage(msg);
                    DsService.this.notifyWidget();
                    error = 0;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getDsApVersion(String[] version) {
            DsLog.log1(DsService.TAG, "IDs.getDsApVersion");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                if (version != null) {
                    try {
                        version[0] = DsService.this.ds_.getDsApVersion();
                        error = 0;
                    } catch (DeadObjectException e) {
                        Log.e(DsService.TAG, "DeadObjectException in getDsApVersion");
                        e.printStackTrace();
                        error = -2;
                    } catch (Exception e2) {
                        Log.e(DsService.TAG, "Exception in getDsApVersion");
                        e2.printStackTrace();
                    }
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getDsVersion(String[] version) {
            int error;
            DsLog.log1(DsService.TAG, "IDs.getDsVersion");
            synchronized (DsService.this.lockDolbyContext_) {
                if (version != null) {
                    version[0] = DsService.this.ds_.getDsVersion();
                    error = 0;
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getMonoSpeaker(boolean[] isMonoSpeaker) {
            DsLog.log1(DsService.TAG, "IDs.getMonoSpeaker");
            if (isMonoSpeaker != null) {
                String monoSpeaker = SystemProperties.get(DsService.PROP_MONO_SPEAKER, "false");
                if (monoSpeaker.equals("true")) {
                    isMonoSpeaker[0] = DsService.isDefaultSettingsOnFileSystem;
                } else {
                    isMonoSpeaker[0] = false;
                }
                return 0;
            }
            return -1;
        }

        @Override // android.dolby.IDs
        public int setIeqPreset(int handle, int profile, int preset) {
            DsLog.log1(DsService.TAG, "IDs.setIeqPreset");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                    try {
                    } catch (Exception e) {
                        Log.e(DsService.TAG, "Exception in setIeqPreset");
                        e.printStackTrace();
                    }
                } catch (DeadObjectException e2) {
                    Log.e(DsService.TAG, "DeadObjectException in setIeqPreset");
                    e2.printStackTrace();
                    error = -2;
                } catch (IllegalArgumentException e3) {
                    Log.e(DsService.TAG, "IllegalArgumentException in setIeqPreset");
                    e3.printStackTrace();
                    error = -1;
                }
                if (DsService.this.ds_.setIeqPreset(profile, preset)) {
                    Message msg = new Message();
                    msg.what = 7;
                    msg.arg1 = handle;
                    msg.arg2 = (16711680 & profile) | preset;
                    DsService.this.mHandler.sendMessage(msg);
                    error = 0;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getIeqPreset(int profile, int[] preset) {
            DsLog.log1(DsService.TAG, "IDs.getIeqPreset");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                if (preset != null) {
                    try {
                        preset[0] = DsService.this.ds_.getIeqPreset(profile);
                        error = 0;
                    } catch (IllegalArgumentException e) {
                        Log.e(DsService.TAG, "IllegalArgumentException in getIeqPreset");
                        e.printStackTrace();
                        error = -1;
                    } catch (Exception e2) {
                        Log.e(DsService.TAG, "Exception in getIeqPreset");
                        e2.printStackTrace();
                    }
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getProfileModified(int profile, int[] modifiedValue) {
            int error;
            DsLog.log1(DsService.TAG, "IDs.getProfileModified");
            synchronized (DsService.this.lockDolbyContext_) {
                if (modifiedValue != null) {
                    modifiedValue[0] = DsService.this.ds_.getProfileModified(profile);
                    DsLog.log1(DsService.TAG, "IDs.getProfileModified " + modifiedValue[0]);
                    error = 0;
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int setGeq(int handle, int profile, int preset, float[] geqBandGains) {
            DsLog.log1(DsService.TAG, "IDs.setGeq");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                    try {
                    } catch (Exception e) {
                        Log.e(DsService.TAG, "Exception in setGeq");
                        e.printStackTrace();
                    }
                } catch (DeadObjectException e2) {
                    Log.e(DsService.TAG, "DeadObjectException in setGeq");
                    e2.printStackTrace();
                    error = -2;
                } catch (IllegalArgumentException e3) {
                    Log.e(DsService.TAG, "IllegalArgumentException in setGeq");
                    e3.printStackTrace();
                    error = -1;
                }
                if (DsService.this.ds_.setGeq(profile, preset, geqBandGains)) {
                    Message msg = new Message();
                    msg.what = 7;
                    msg.arg1 = handle;
                    msg.arg2 = (16711680 & profile) | preset;
                    DsService.this.mHandler.sendMessage(msg);
                    error = 0;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getGeq(int profile, int preset, float[] gains) {
            DsLog.log1(DsService.TAG, "IDs.getGeq");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                    float[] realGains = DsService.this.ds_.getGeq(profile, preset);
                    System.arraycopy(realGains, 0, gains, 0, realGains.length);
                    error = 0;
                } catch (IllegalArgumentException e) {
                    Log.e(DsService.TAG, "IllegalArgumentException in getGeq");
                    e.printStackTrace();
                    error = -1;
                } catch (Exception e2) {
                    Log.e(DsService.TAG, "Exception in getGeq");
                    e2.printStackTrace();
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int setDsApParam(int handle, String parameter, int[] values) {
            DsLog.log1(DsService.TAG, "IDs.setDsApParam");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                try {
                } catch (DeadObjectException e) {
                    Log.e(DsService.TAG, "DeadObjectException in setDsApParam");
                    e.printStackTrace();
                    error = -2;
                } catch (UnsupportedOperationException e2) {
                    Log.e(DsService.TAG, "UnsupportedOperationException in setDsApParam");
                    e2.printStackTrace();
                    error = -4;
                } catch (Exception e3) {
                    Log.e(DsService.TAG, "Exception in setDsApParam");
                    e3.printStackTrace();
                }
                if (DsService.this.ds_.setDsApParam(parameter, values)) {
                    Message msg = new Message();
                    if (DsService.this.ds_.isBasicProfileSettings(parameter)) {
                        msg.what = 3;
                    } else {
                        msg.what = 8;
                        msg.obj = new String(parameter);
                    }
                    msg.arg1 = handle;
                    msg.arg2 = DsService.this.ds_.getSelectedProfile();
                    DsService.this.mHandler.sendMessage(msg);
                    error = 0;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getDsApParam(String parameter, int[] values) {
            DsLog.log1(DsService.TAG, "IDs.getDsApParam");
            int error = -5;
            synchronized (DsService.this.lockDolbyContext_) {
                int[] realParam = DsService.this.ds_.getDsApParam(parameter);
                System.arraycopy(realParam, 0, values, 0, realParam.length);
                if (values != null) {
                    error = 0;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public int getDsApParamLength(String parameter, int[] len) {
            int error;
            DsLog.log1(DsService.TAG, "IDs.getDsApParamLength");
            synchronized (DsService.this.lockDolbyContext_) {
                if (len != null) {
                    len[0] = DsService.this.ds_.getDsApParamLength(parameter);
                    error = 0;
                } else {
                    error = -1;
                }
            }
            return error;
        }

        @Override // android.dolby.IDs
        public void registerDsApParamEvents(int handle) {
            synchronized (DsService.this.lockCallbacks_) {
                DsService.this.dsApParamEventList_.add(new Integer(handle));
                DsLog.log1(DsService.TAG, "registerDsApParamEvents: Add a client handle " + handle);
            }
        }

        @Override // android.dolby.IDs
        public void unregisterDsApParamEvents(int handle) {
            synchronized (DsService.this.lockCallbacks_) {
                int size = DsService.this.dsApParamEventList_.size();
                if (size != 0) {
                    Iterator i$ = DsService.this.dsApParamEventList_.iterator();
                    while (true) {
                        if (!i$.hasNext()) {
                            break;
                        }
                        Integer hdl = (Integer) i$.next();
                        if (handle == hdl.intValue()) {
                            DsService.this.dsApParamEventList_.remove(hdl);
                            DsLog.log1(DsService.TAG, "unregisterDsApParamEvents: remove a client handle " + handle);
                            break;
                        }
                    }
                    return;
                }
                DsLog.log1(DsService.TAG, "unregisterDsApParamEvents: No client handle registered, do nothing.");
            }
        }

        @Override // android.dolby.IDs
        public void registerCallback(IDsServiceCallbacks cb, int handle) {
            if (cb != null) {
                synchronized (DsService.this.lockCallbacks_) {
                    DsService.this.callbacks_.register(cb, Integer.valueOf(handle));
                    DsLog.log1(DsService.TAG, "the register handle is " + handle);
                }
            }
        }

        @Override // android.dolby.IDs
        public void unregisterCallback(IDsServiceCallbacks cb) {
            if (cb != null) {
                synchronized (DsService.this.lockDolbyContext_) {
                    synchronized (DsService.this.lockCallbacks_) {
                        DsService.this.callbacks_.unregister(cb);
                        if (!DsService.this.nonPersistentMode_) {
                            DsService.this.ds_.saveDsStateAndSettings();
                        }
                        DsLog.log1(DsService.TAG, "unregisterCallback");
                    }
                }
            }
        }

        @Override // android.dolby.IDs
        public void registerVisualizerData(int handle) {
            synchronized (DsService.this.lockDolbyContext_) {
                synchronized (DsService.this.lockCallbacks_) {
                    int size = DsService.this.visualizerList_.size();
                    if (size == 0) {
                        DsService.this.startVisualizer();
                    }
                    DsService.this.visualizerList_.add(new Integer(handle));
                    if (DsService.this.isVisualizerSuspended_) {
                        Message msg = new Message();
                        msg.what = 6;
                        DsService.this.mHandler.sendMessage(msg);
                    }
                    DsLog.log1(DsService.TAG, "Add a visualzier handle " + handle);
                }
            }
        }

        @Override // android.dolby.IDs
        public void unregisterVisualizerData(int handle) {
            synchronized (DsService.this.lockDolbyContext_) {
                synchronized (DsService.this.lockCallbacks_) {
                    int size = DsService.this.visualizerList_.size();
                    if (size != 0) {
                        Iterator i$ = DsService.this.visualizerList_.iterator();
                        while (true) {
                            if (!i$.hasNext()) {
                                break;
                            }
                            Integer hdl = (Integer) i$.next();
                            if (handle == hdl.intValue()) {
                                DsService.this.visualizerList_.remove(hdl);
                                DsLog.log1(DsService.TAG, "remove a visualzier handle " + handle);
                                int newSize = DsService.this.visualizerList_.size();
                                if (newSize == 0) {
                                    DsService.this.stopVisualizer();
                                }
                            }
                        }
                        return;
                    }
                    Log.e(DsService.TAG, "No client registering, do nothing.");
                }
            }
        }
    };
    private final Handler mHandler = new Handler() { // from class: com.dolby.DsService.4
        @Override // android.os.Handler
        public void handleMessage(Message msg) {
            synchronized (DsService.this.lockDolbyContext_) {
                switch (msg.what) {
                    case 1:
                        DsLog.log2(DsService.TAG, "handling the DS_STATUS_CHANGES_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            int setter_handle = msg.arg1;
                            boolean isEffectOn = msg.arg2 == 1 ? DsService.isDefaultSettingsOnFileSystem : false;
                            int N = DsService.this.callbacks_.beginBroadcast();
                            for (int i = 0; i < N; i++) {
                                try {
                                    if (((Integer) DsService.this.callbacks_.getBroadcastCookie(i)).intValue() != setter_handle) {
                                        ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i)).onDsOn(isEffectOn);
                                    }
                                } catch (RemoteException e) {
                                }
                            }
                            DsService.this.callbacks_.finishBroadcast();
                            break;
                        }
                        break;
                    case 2:
                        DsLog.log2(DsService.TAG, "handling the PROFILE_SELECTED_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            int setter_handle2 = msg.arg1;
                            int profile = msg.arg2;
                            int N2 = DsService.this.callbacks_.beginBroadcast();
                            for (int i2 = 0; i2 < N2; i2++) {
                                try {
                                    if (((Integer) DsService.this.callbacks_.getBroadcastCookie(i2)).intValue() != setter_handle2) {
                                        ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i2)).onProfileSelected(profile);
                                    }
                                } catch (RemoteException e2) {
                                }
                            }
                            DsService.this.callbacks_.finishBroadcast();
                            break;
                        }
                        break;
                    case 3:
                        DsLog.log2(DsService.TAG, "handling the PROFILE_SETTINGS_CHANGED_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            int setter_handle3 = msg.arg1;
                            int profile2 = msg.arg2;
                            int N3 = DsService.this.callbacks_.beginBroadcast();
                            for (int i3 = 0; i3 < N3; i3++) {
                                try {
                                    if (((Integer) DsService.this.callbacks_.getBroadcastCookie(i3)).intValue() != setter_handle3) {
                                        ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i3)).onProfileSettingsChanged(profile2);
                                    }
                                } catch (RemoteException e3) {
                                }
                            }
                            DsService.this.callbacks_.finishBroadcast();
                            break;
                        }
                        break;
                    case 4:
                        DsLog.log2(DsService.TAG, "handling the PROFILE_NAME_CHANGED_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            int setter_handle4 = msg.arg1;
                            int profile3 = msg.arg2;
                            String name = (String) msg.obj;
                            int N4 = DsService.this.callbacks_.beginBroadcast();
                            for (int i4 = 0; i4 < N4; i4++) {
                                try {
                                    if (((Integer) DsService.this.callbacks_.getBroadcastCookie(i4)).intValue() != setter_handle4) {
                                        ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i4)).onProfileNameChanged(profile3, name);
                                    }
                                } catch (RemoteException e4) {
                                }
                            }
                            DsService.this.callbacks_.finishBroadcast();
                            break;
                        }
                        break;
                    case 5:
                        DsLog.log2(DsService.TAG, "handling the VISUALIZER_UPDATED_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            if (!DsService.this.isVisualizerSuspended_) {
                                int N5 = DsService.this.callbacks_.beginBroadcast();
                                for (Integer hdl : DsService.this.visualizerList_) {
                                    int handle = hdl.intValue();
                                    for (int i5 = 0; i5 < N5; i5++) {
                                        try {
                                            if (((Integer) DsService.this.callbacks_.getBroadcastCookie(i5)).intValue() == handle) {
                                                ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i5)).onVisualizerUpdated(DsService.this.gains_, DsService.this.excitations_);
                                            }
                                        } catch (RemoteException e5) {
                                        }
                                    }
                                }
                                DsService.this.callbacks_.finishBroadcast();
                            }
                            break;
                        }
                        break;
                    case 6:
                        DsLog.log2(DsService.TAG, "handling the VISUALIZER_SUSPENDED_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            int N6 = DsService.this.callbacks_.beginBroadcast();
                            for (Integer hdl2 : DsService.this.visualizerList_) {
                                int handle2 = hdl2.intValue();
                                for (int i6 = 0; i6 < N6; i6++) {
                                    try {
                                        if (((Integer) DsService.this.callbacks_.getBroadcastCookie(i6)).intValue() == handle2) {
                                            ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i6)).onVisualizerSuspended(DsService.this.isVisualizerSuspended_);
                                        }
                                    } catch (RemoteException e6) {
                                    }
                                }
                            }
                            DsService.this.callbacks_.finishBroadcast();
                            break;
                        }
                        break;
                    case DsCommon.EQ_SETTINGS_CHANGED_MSG /* 7 */:
                        DsLog.log2(DsService.TAG, "handling the EQ_SETTINGS_CHANGED_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            int setter_handle5 = msg.arg1;
                            int profile4 = msg.arg2 & 65280;
                            int preset = msg.arg2 & 255;
                            int N7 = DsService.this.callbacks_.beginBroadcast();
                            for (int i7 = 0; i7 < N7; i7++) {
                                try {
                                    if (((Integer) DsService.this.callbacks_.getBroadcastCookie(i7)).intValue() != setter_handle5) {
                                        ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i7)).onEqSettingsChanged(profile4, preset);
                                    }
                                } catch (RemoteException e7) {
                                }
                            }
                            DsService.this.callbacks_.finishBroadcast();
                            break;
                        }
                        break;
                    case DsCommon.DS_PARAM_CHANGED_MSG /* 8 */:
                        DsLog.log2(DsService.TAG, "handling the DS_PARAM_CHANGED_MSG message...");
                        synchronized (DsService.this.lockCallbacks_) {
                            int setter_handle6 = msg.arg1;
                            int profile5 = msg.arg2;
                            String paramName = (String) msg.obj;
                            int N8 = DsService.this.callbacks_.beginBroadcast();
                            for (Integer hdl3 : DsService.this.dsApParamEventList_) {
                                int handle3 = hdl3.intValue();
                                for (int i8 = 0; i8 < N8; i8++) {
                                    try {
                                        int j = ((Integer) DsService.this.callbacks_.getBroadcastCookie(i8)).intValue();
                                        if (j == handle3 && j != setter_handle6) {
                                            ((IDsServiceCallbacks) DsService.this.callbacks_.getBroadcastItem(i8)).onDsApParamChange(profile5, paramName);
                                        }
                                    } catch (RemoteException e8) {
                                    }
                                }
                            }
                            DsService.this.callbacks_.finishBroadcast();
                            break;
                        }
                        break;
                    default:
                        super.handleMessage(msg);
                        break;
                }
            }
        }
    };

    /* JADX INFO: Access modifiers changed from: private */
    public void visualizerUpdate() {
        synchronized (this.lockDolbyContext_) {
            int len = 0;
            try {
                len = this.ds_.getVisualizerData(this.gains_, this.excitations_);
                if (len != this.previousVisualizerSize_) {
                    this.noVisualizerCounter_ = 0;
                }
                this.previousVisualizerSize_ = len;
            } catch (Exception e) {
                Log.e(TAG, "Exception in visualizerUpdate");
                e.printStackTrace();
            }
            if (len == 0) {
                if (!this.isVisualizerSuspended_) {
                    this.noVisualizerCounter_++;
                    if (this.noVisualizerCounter_ >= COUNTER_THRESHOLD) {
                        this.isVisualizerSuspended_ = isDefaultSettingsOnFileSystem;
                        this.noVisualizerCounter_ = 0;
                        Message msg = new Message();
                        msg.what = 6;
                        this.mHandler.sendMessage(msg);
                        DsLog.log1(TAG, "send VISUALIZER_SUSPENDED_MSG with true");
                    }
                }
            } else if (this.isVisualizerSuspended_) {
                this.noVisualizerCounter_++;
                if (this.noVisualizerCounter_ >= COUNTER_THRESHOLD) {
                    this.isVisualizerSuspended_ = false;
                    this.noVisualizerCounter_ = 0;
                    Message msg2 = new Message();
                    msg2.what = 6;
                    this.mHandler.sendMessage(msg2);
                    DsLog.log1(TAG, "send VISUALIZER_SUSPENDED_MSG with false");
                }
            } else {
                try {
                    if (!this.ds_.getDsOn()) {
                        for (int i = 0; i < this.geqBandCount_; i++) {
                            this.gains_[i] = 0.0f;
                            this.excitations_[i] = 0.0f;
                        }
                    }
                } catch (Exception e2) {
                    Log.e(TAG, "Exception found in visualizerUpdate");
                    e2.printStackTrace();
                }
                Message msg3 = new Message();
                msg3.what = 5;
                this.mHandler.sendMessage(msg3);
            }
            if (this.visualizerHandler_ != null) {
                this.visualizerHandler_.removeCallbacks(this.cbkOnVisualizerUpdate_);
                this.visualizerHandler_.postDelayed(this.cbkOnVisualizerUpdate_, 50L);
            }
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void startVisualizer() {
        try {
            if (this.ds_.getDsOn()) {
                this.ds_.setVisualizerOn(isDefaultSettingsOnFileSystem);
                if (this.visualizerThread_ == null) {
                    this.visualizerThread_ = new HandlerThread("visualiser thread");
                    this.visualizerThread_.start();
                }
                if (this.visualizerHandler_ == null) {
                    this.visualizerHandler_ = new Handler(this.visualizerThread_.getLooper());
                }
                this.visualizerHandler_.post(this.cbkOnVisualizerUpdate_);
                DsLog.log1(TAG, "Visualizer thread is started.");
                return;
            }
            DsLog.log1(TAG, "DS is off, will start visualizer thread when it switches to on.");
        } catch (Exception e) {
            Log.e(TAG, "Exception found in startVisualizer");
            e.printStackTrace();
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void stopVisualizer() {
        try {
            this.ds_.setVisualizerOn(false);
            if (this.visualizerHandler_ != null) {
                this.visualizerHandler_.getLooper().quit();
                this.visualizerHandler_ = null;
                this.visualizerThread_ = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "Exception found in stopVisualizer");
            e.printStackTrace();
        }
        for (int i = 0; i < this.geqBandCount_; i++) {
            this.gains_[i] = 0.0f;
            this.excitations_[i] = 0.0f;
        }
        this.noVisualizerCounter_ = 0;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void notifyWidget() {
        try {
            DsWidgetStatus newStatus = DsWidgetStatus.getInstance();
            newStatus.setOn(this.ds_.getDsOn());
            int selectedProfile = this.ds_.getSelectedProfile();
            newStatus.setProfile(selectedProfile);
            int modifiedValue = this.ds_.getProfileModified(selectedProfile);
            if ((modifiedValue & 2) == 2) {
                newStatus.setProfileName(this.ds_.getProfileNames()[selectedProfile]);
                newStatus.setModified(isDefaultSettingsOnFileSystem);
            } else {
                newStatus.setModified(false);
            }
            if (this.appWidgetList_.size() == 0) {
                if (DolbyWidgetExtraLargeProvider.getInstance() != null) {
                    this.appWidgetList_.add(DolbyWidgetExtraLargeProvider.getInstance());
                }
                if (DolbyWidgetSmallProvider.getInstance() != null) {
                    this.appWidgetList_.add(DolbyWidgetSmallProvider.getInstance());
                }
            }
            int n = this.appWidgetList_.size();
            for (int i = 0; i < n; i++) {
                IDolbyWidgetUpdateStatus widget = this.appWidgetList_.get(i);
                if (widget != null) {
                    DsLog.log2(TAG, "notifyWidget, i = " + i);
                    widget.notifyStatusUpdate(this, newStatus);
                }
            }
        } catch (Exception ex) {
            Log.e(TAG, "Exception found in DsService::notifyWidget()");
            ex.printStackTrace();
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void sendAllEventsToClients() {
        try {
            boolean newStatus = this.ds_.getDsOn();
            Message msg = new Message();
            msg.what = 1;
            msg.arg1 = 0;
            msg.arg2 = !newStatus ? 0 : 1;
            this.mHandler.sendMessage(msg);
            Message msg2 = new Message();
            msg2.what = 2;
            msg2.arg1 = 0;
            msg2.arg2 = this.ds_.getSelectedProfile();
            this.mHandler.sendMessage(msg2);
            for (int i = 0; i <= 5; i++) {
                Message msg3 = new Message();
                msg3.what = 3;
                msg3.arg1 = 0;
                msg3.arg2 = i;
                this.mHandler.sendMessage(msg3);
                if (i >= 4) {
                    String[] names = this.ds_.getProfileNames();
                    Message msg4 = new Message();
                    msg4.what = 4;
                    msg4.arg1 = 0;
                    msg4.arg2 = i;
                    msg4.obj = new String(names[i]);
                    this.mHandler.sendMessage(msg4);
                }
            }
            synchronized (this.lockDolbyContext_) {
                notifyWidget();
            }
        } catch (Exception ex) {
            Log.e(TAG, "Exception found in DsService::notifyClients()");
            ex.printStackTrace();
        }
    }

    @Override // android.app.Service
    public void onCreate() {
        DsLog.log1(TAG, "DsService.onCreate()");
        try {
            state_createDs(null);
            IntentFilter commandFilter = new IntentFilter();
            commandFilter.addAction(DsCommon.INIT_ACTION);
            commandFilter.addAction("android.intent.action.REBOOT");
            commandFilter.addAction("android.intent.action.ACTION_SHUTDOWN");
            commandFilter.addAction("media_server_started");
            commandFilter.addAction(LPA_SESSION_ID_CHANGED_ACTION);
            commandFilter.addAction(LPA_SESSION_ID_REMOVED_ACTION);
            commandFilter.addAction(DS_EFFECT_SUSPEND_ACTION);
            registerReceiver(this.intentReceiver_, commandFilter);
        } catch (Exception ex) {
            Log.e(TAG, "Exception found in DsService.onCreate()");
            ex.printStackTrace();
        }
    }

    @Override // android.app.Service
    public void onDestroy() {
        DsLog.log1(TAG, "DsService.onDestroy()");
        synchronized (this.lockDolbyContext_) {
            if (!this.nonPersistentMode_) {
                this.ds_.saveDsStateAndSettings();
            }
            try {
                this.ds_.setDsOn(false);
            } catch (Exception ex) {
                Log.e(TAG, "Exception found in DsService.onDestory()");
                ex.printStackTrace();
            }
        }
        synchronized (this.lockCallbacks_) {
            this.callbacks_.kill();
            int size = this.visualizerList_.size();
            for (int i = 0; i < size; i++) {
                this.visualizerList_.remove(i);
            }
            this.visualizerList_ = null;
        }
        this.mHandler.removeMessages(1);
        this.mHandler.removeMessages(2);
        this.mHandler.removeMessages(3);
        this.mHandler.removeMessages(4);
        this.mHandler.removeMessages(5);
        this.mHandler.removeMessages(6);
        this.mHandler.removeMessages(7);
        this.mHandler.removeMessages(8);
        Toast.makeText(this, R.string.remote_service_stopped, 0).show();
        unregisterReceiver(this.intentReceiver_);
    }

    @Override // android.app.Service
    public int onStartCommand(Intent callerIntent, int flags, int startId) {
        Intent intent;
        DsLog.log1(TAG, "DsService.onStartCommand()");
        try {
        } catch (Exception ex) {
            Log.e(TAG, "DsService.onStartCommand() exception found");
            ex.printStackTrace();
            return 1;
        }
        if (callerIntent != null) {
            String action = callerIntent.getAction();
            DsLog.log1(TAG, "Intent action is " + action);
            if (DsCommon.ONOFF_ACTION.equals(action)) {
                synchronized (this.lockDolbyContext_) {
                    doToggleDsOn(0);
                }
                return 1;
            }
            if (DsCommon.SELECTPROFILE_ACTION.equals(action)) {
                synchronized (this.lockDolbyContext_) {
                    int profile = callerIntent.getIntExtra(DsCommon.CMDNAME, 0);
                    doSetSelectedProfile(0, profile);
                }
                return 1;
            }
            if (DsCommon.LAUNCH_DOLBY_APP_ACTION.equals(action) && (intent = getDsConsumerAppIntent()) != null) {
                intent.addFlags(268435456);
                startActivity(intent);
                return 1;
            }
            return 1;
            Log.e(TAG, "DsService.onStartCommand() exception found");
            ex.printStackTrace();
            return 1;
        }
        DsLog.log1(TAG, "onStartCommand: callerIntent==null, ignoring...");
        return 1;
    }

    @Override // android.app.Service
    public IBinder onBind(Intent intent) {
        DsLog.log1(TAG, "DsService.onBind()");
        if (IDs.class.getName().equals(intent.getAction())) {
            return this.binder_;
        }
        Log.e(TAG, "/DsService.onBind() - return null");
        return null;
    }

    @Override // android.app.Service, android.content.ComponentCallbacks2
    public void onTrimMemory(int level) {
        DsLog.log1(TAG, "DsService.onTrimMemory() level " + level);
    }

    @Override // android.app.Service, android.content.ComponentCallbacks
    public void onLowMemory() {
        DsLog.log1(TAG, "DsService.onLowMemory()");
    }

    /* JADX INFO: Access modifiers changed from: private */
    public boolean loadSettings(String path) {
        boolean ret = isDefaultSettingsOnFileSystem;
        String fileDir = null;
        InputStream defaultInStream = null;
        try {
            fileDir = getFilesDir().getAbsolutePath();
            DsLog.log1(TAG, "Adopting the file system settings...");
            if (path != null) {
                defaultInStream = new FileInputStream(path);
            } else {
                Log.e(TAG, "The user settings path NOT defined!");
            }
            File file = new File(fileDir, Ds.DS_CURRENT_FILENAME);
            if (file.exists()) {
                DsLog.log1(TAG, file.getAbsolutePath() + " alread exists");
            } else {
                DsLog.log1(TAG, "Creating " + file.getAbsolutePath());
                FileOutputStream fos = openFileOutput(Ds.DS_CURRENT_FILENAME, 0);
                fos.close();
            }
            File file2 = new File(fileDir, Ds.DS_STATE_FILENAME);
            if (file2.exists()) {
                DsLog.log1(TAG, file2.getAbsolutePath() + " alread exists");
            } else {
                DsLog.log1(TAG, "Creating " + file2.getAbsolutePath());
                FileOutputStream fos2 = openFileOutput(Ds.DS_STATE_FILENAME, 0);
                fos2.close();
            }
        } catch (FileNotFoundException e) {
            Log.e(TAG, "FileNotFoundException was caught");
            e.printStackTrace();
            ret = false;
        } catch (IOException e2) {
            Log.e(TAG, "IOException was caught");
            e2.printStackTrace();
            ret = false;
        } catch (Exception e3) {
            Log.e(TAG, "Exception was caught");
            e3.printStackTrace();
            ret = false;
        }
        if (defaultInStream != null) {
            if (ret) {
                Ds ds = this.ds_;
                return Ds.populateSettings(defaultInStream, fileDir);
            }
            try {
                defaultInStream.close();
                return ret;
            } catch (IOException e4) {
                e4.printStackTrace();
                return ret;
            }
        }
        return false;
    }

    private void state_createDs(Intent callerIntent) {
        DsLog.log1(TAG, "createDs()");
        try {
            synchronized (this.lockDolbyContext_) {
                if (loadSettings("/system/etc/ds1-default.xml")) {
                    this.geqBandCount_ = DsAkSettings.getGeqBandCount();
                    if (this.geqBandCount_ > 0) {
                        this.gains_ = new float[this.geqBandCount_];
                        this.excitations_ = new float[this.geqBandCount_];
                        this.ds_ = new Ds(0);
                        boolean on = this.ds_.getDsOn();
                        int profile = this.ds_.getSelectedProfile();
                        String curState = on ? STATE_ON : STATE_OFF;
                        SystemProperties.set(PROP_DS_STATE, curState);
                        setProfileProperties(profile);
                        SharedPreferences pref = getSharedPreferences("musicfx", 0);
                        SharedPreferences.Editor ed = pref.edit();
                        ed.putString("defaultpanelpackage", "com.dolby.ds1appUI");
                        ed.putString("defaultpanelname", "com.dolby.ds1appUI.MainActivity");
                        ed.commit();
                        DsLog.log1(TAG, "wrote com.dolby.ds1appUI/com.dolby.ds1appUI.MainActivity as default");
                    } else {
                        Log.e(TAG, "createDs() FAILED! graphic equalizer band count NOT initialized yet.");
                    }
                } else {
                    Log.e(TAG, "createDs() FAILED! DS settings are NOT loaded successfully.");
                }
            }
        } catch (ClassNotFoundException e) {
            Log.e(TAG, "Ds() FAILED! ClassNotFoundException");
        } catch (IllegalAccessException e2) {
            Log.e(TAG, "Ds() FAILED! IllegalAccessException");
        } catch (IllegalStateException e3) {
            Log.e(TAG, "Ds() FAILED! IllegalStateException");
        } catch (InstantiationException e4) {
            Log.e(TAG, "Ds() FAILED! InstantiationException");
        } catch (NoSuchMethodException e5) {
            Log.e(TAG, "Ds() FAILED! NoSuchMethodException");
        } catch (InvocationTargetException e6) {
            Log.e(TAG, "Ds() FAILED! InvocationTargetException");
        } catch (Exception ex) {
            Log.e(TAG, "Ds() FAILED! Exception");
            ex.printStackTrace();
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void setProfileProperties(int profile) {
        SystemProperties.set(PROP_DS_PROFILE_NAME, DsCommon.PROFILE_NAMES[profile]);
        DsClientSettings settings = this.ds_.getProfileSettings(profile);
        String state = settings.getDialogEnhancerOn() ? STATE_ON : STATE_OFF;
        SystemProperties.set(PROP_DS_DIALOGENHANCER_STATE, state);
        String state2 = settings.getHeadphoneVirtualizerOn() ? STATE_ON : STATE_OFF;
        SystemProperties.set(PROP_DS_HEADPHONE_VIRTUALIZER_STATE, state2);
        String state3 = settings.getSpeakerVirtualizerOn() ? STATE_ON : STATE_OFF;
        SystemProperties.set(PROP_DS_SPEAKER_VIRTUALIZER_STATE, state3);
        String state4 = settings.getVolumeLevellerOn() ? STATE_ON : STATE_OFF;
        SystemProperties.set(PROP_DS_VOLUMELEVELER_STATE, state4);
        String state5 = settings.getGeqOn() ? STATE_ON : STATE_OFF;
        SystemProperties.set(PROP_DS_GEQ_STATE, state5);
        int index = this.ds_.getIeqPreset(profile);
        if (index == 0) {
            SystemProperties.set(PROP_DS_IEQ_STATE, STATE_OFF);
        } else {
            SystemProperties.set(PROP_DS_IEQ_STATE, STATE_ON);
        }
        SystemProperties.set(PROP_DS_IEQ_PRESET, DsCommon.IEQ_PRESET_NAMES[index]);
    }

    private Intent getDsConsumerAppIntent() {
        Intent intent = new Intent(ACTION_DOLBY_LAUNCH_APP);
        PackageManager p = getPackageManager();
        if (p == null) {
            return null;
        }
        List<ResolveInfo> ris = p.queryIntentActivities(intent, 512);
        if (ris == null || ris.isEmpty()) {
            return null;
        }
        return intent;
    }

    private int doToggleDsOn(int handle) throws DeadObjectException {
        int iDoSetDsOn;
        synchronized (this.lockDolbyContext_) {
            boolean on = this.ds_.getDsOn();
            iDoSetDsOn = doSetDsOn(handle, !on ? isDefaultSettingsOnFileSystem : false);
        }
        return iDoSetDsOn;
    }

    /* JADX INFO: Access modifiers changed from: private */
    public int doSetDsOn(int handle, boolean on) throws DeadObjectException {
        int size;
        synchronized (this.lockDolbyContext_) {
            if (this.isDsEffectSuspended && !this.ds_.isLpaActive() && on) {
                DsLog.log1(TAG, "DS_REQUEST_FAILED_EFFECT_SUSPENDED");
                return 1;
            }
            this.ds_.setDsOn(on);
            boolean newStatus = this.ds_.getDsOn();
            String curState = newStatus ? STATE_ON : STATE_OFF;
            SystemProperties.set(PROP_DS_STATE, curState);
            Message msg = new Message();
            msg.what = 1;
            msg.arg1 = handle;
            msg.arg2 = !newStatus ? 0 : 1;
            this.mHandler.sendMessage(msg);
            notifyWidget();
            synchronized (this.lockCallbacks_) {
                size = this.visualizerList_.size();
            }
            if (size > 0) {
                if (newStatus) {
                    startVisualizer();
                } else {
                    stopVisualizer();
                    Message msg2 = new Message();
                    msg2.what = 5;
                    this.mHandler.sendMessage(msg2);
                }
            }
            return 0;
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public boolean doSetSelectedProfile(int handle, int profile) throws DeadObjectException {
        boolean z;
        synchronized (this.lockDolbyContext_) {
            boolean success = this.ds_.setSelectedProfile(profile);
            int newProfile = this.ds_.getSelectedProfile();
            if (success && profile == newProfile) {
                setProfileProperties(newProfile);
                Message msg = new Message();
                msg.what = 2;
                msg.arg1 = handle;
                msg.arg2 = profile;
                this.mHandler.sendMessage(msg);
                notifyWidget();
            }
            z = (success && profile == newProfile) ? isDefaultSettingsOnFileSystem : false;
        }
        return z;
    }
}
