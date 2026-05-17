package com.dolby.instoredemoapp;

import android.app.Activity;
import android.content.Context;
import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.dolby.IDsClientEvents;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Message;
import android.util.Log;
import java.io.InputStream;
import java.util.ArrayList;

/* JADX INFO: loaded from: classes.dex */
public class DlbApController implements IDsClientEvents {
    private static final String TAG = "DlbApController";
    private Context mContext;
    private ArrayList<DsClientSettingsData> mDsClientSettingsDataList;
    private Handler mHandler;
    private MediaPlayer mMediaPlayer;
    private ArrayList<APMessage> mMsgList;
    private int mPrevIeqPreset;
    private int mPrevProfile;
    private ArrayList<Integer> mProfilesArray;
    private InputStream mApInfoStream = null;
    private boolean mDsConnected = false;
    private boolean mPrevDsOnStat = false;
    private DlbApInfoExtractor mApInfoExtractor = new DlbApInfoExtractor();
    private DsClient mDsClient = new DsClient();

    private class APMessage {
        public long delayTime;
        public Message message;

        public APMessage(long time, Message msg) {
            this.delayTime = time;
            this.message = msg;
        }
    }

    public DlbApController(Context ctx) {
        this.mContext = ctx;
        try {
            Log.d(TAG, "going to bind the DS service...");
            this.mDsClient.bindDsService((Activity) this.mContext);
            this.mDsClient.setEventListener(this);
        } catch (Exception e) {
            Log.e(TAG, "Consturction of DlbApController, bindDsService failed");
            e.printStackTrace();
        }
    }

    public void setMediaPlayer(MediaPlayer mp) {
        if (mp != null) {
            this.mMediaPlayer = mp;
        }
    }

    public void setHandler(Handler handler) {
        if (handler != null) {
            this.mHandler = handler;
        }
    }

    public void onExit() {
        this.mDsClient.setEventListener((IDsClientEvents) null);
        try {
            Log.d(TAG, "about to unbind DS service...");
            this.mDsClient.unBindDsService((Activity) this.mContext);
        } catch (Exception e) {
            Log.e(TAG, "DlbApController.onExit(), unBindDsService failed");
        }
        this.mDsConnected = false;
    }

    public void sendApMessages() {
        if (this.mHandler != null) {
            Log.d(TAG, "the un-handled messages will be removed!");
            this.mHandler.removeCallbacksAndMessages(null);
        }
        Log.d(TAG, "duaration of the media is " + this.mMediaPlayer.getDuration());
        for (int i = 0; i < this.mMsgList.size(); i++) {
            APMessage apmsg = this.mMsgList.get(i);
            Log.d(TAG, "will send ap msg after " + apmsg.delayTime + " millisecond");
            this.mHandler.sendMessageDelayed(apmsg.message, apmsg.delayTime);
        }
    }

    public void setApInfoFile(InputStream apstream) {
        this.mApInfoStream = apstream;
        this.mApInfoExtractor.setApInfoFile(this.mApInfoStream);
        initMsgList();
    }

    private class DsClientSettingsData {
        public DsClientSettings mDsClientSettings;
        public int mIeqPreset;
        public int mProfile;

        public DsClientSettingsData(int profile, int ieq, DsClientSettings dscs) {
            this.mProfile = profile;
            this.mIeqPreset = ieq;
            this.mDsClientSettings = dscs;
        }
    }

    public boolean saveCurrentDs1Data() {
        Log.d(TAG, "saveCurrentDs1Data");
        try {
            this.mPrevDsOnStat = this.mDsClient.getDsOn();
            this.mPrevProfile = this.mDsClient.getSelectedProfile();
            this.mPrevIeqPreset = this.mDsClient.getIeqPreset(this.mPrevProfile);
            Log.d(TAG, "mPrevDsOnStat = " + this.mPrevDsOnStat);
            Log.d(TAG, "mPrevProfile = " + this.mPrevProfile);
            Log.d(TAG, "mPrevIeqPreset = " + this.mPrevIeqPreset);
            this.mProfilesArray = new ArrayList<>();
            ArrayList<AutoPilotItem> aplist = this.mApInfoExtractor.getAutoPilotMetadata();
            for (int i = 0; i < aplist.size(); i++) {
                AutoPilotItem item = aplist.get(i);
                String proctl = item.getProfileControlValue();
                if (!proctl.equalsIgnoreCase("unset")) {
                    int profile = -1;
                    if (proctl.equalsIgnoreCase("Movie")) {
                        profile = 0;
                    } else if (proctl.equalsIgnoreCase("Music")) {
                        profile = 1;
                    } else if (proctl.equalsIgnoreCase("Game")) {
                        profile = 2;
                    } else if (proctl.equalsIgnoreCase("Voice")) {
                        profile = 3;
                    } else {
                        Log.e(TAG, "DlbApController.saveCurrentDs1Data, invalide profile name = " + proctl);
                    }
                    Integer profileInt = Integer.valueOf(profile);
                    if (profile != -1 && !this.mProfilesArray.contains(profileInt)) {
                        this.mProfilesArray.add(profileInt);
                    }
                }
            }
            Log.d(TAG, "mProfilesArray.size = " + this.mProfilesArray.size());
            Log.d(TAG, "mProfilesArray = " + this.mProfilesArray.toString());
            this.mDsClientSettingsDataList = new ArrayList<>();
            int profileCnt = this.mProfilesArray.size();
            Log.d(TAG, "profileCnt = " + profileCnt);
            for (int i2 = 0; i2 < profileCnt; i2++) {
                try {
                    int profile2 = this.mProfilesArray.get(i2).intValue();
                    int ieqPreset = this.mDsClient.getIeqPreset(profile2);
                    DsClientSettings dscs = this.mDsClient.getProfileSettings(profile2);
                    DsClientSettingsData dscsdata = new DsClientSettingsData(profile2, ieqPreset, dscs);
                    this.mDsClientSettingsDataList.add(dscsdata);
                } catch (Exception e) {
                    Log.e(TAG, "DlbApController.saveCurrentDs1Data, fail to call setIeqPreset");
                    e.printStackTrace();
                    return false;
                }
            }
            Log.d(TAG, "the size of mDsClientSettingsDataList = " + this.mDsClientSettingsDataList.size());
            for (int i3 = 0; i3 < profileCnt; i3++) {
                try {
                    this.mDsClient.resetProfile(this.mProfilesArray.get(i3).intValue());
                } catch (Exception e2) {
                    Log.e(TAG, "DlbApController.saveCurrentDs1Data, fail to call resetProfile");
                    e2.printStackTrace();
                    return false;
                }
            }
            return true;
        } catch (Exception e3) {
            Log.e(TAG, "DlbApController.saveCurrentDs1Data fail to call getDsOn or getSelectedProfile or getIeqPreset");
            e3.printStackTrace();
            return false;
        }
    }

    public void restoreAllDs1Data() {
        Log.d(TAG, "restoreAllDs1Data");
        for (int i = 0; i < this.mDsClientSettingsDataList.size(); i++) {
            DsClientSettingsData dscd = this.mDsClientSettingsDataList.get(i);
            try {
                this.mDsClient.setSelectedProfile(dscd.mProfile);
                this.mDsClient.setIeqPreset(dscd.mProfile, dscd.mIeqPreset);
                this.mDsClient.setProfileSettings(dscd.mProfile, dscd.mDsClientSettings);
            } catch (Exception e) {
                Log.e(TAG, "DlbApController.restoreAllDs1Data, fail to call setIeqPreset or setProfileSettings");
                e.printStackTrace();
                this.mHandler.sendEmptyMessage(ConstValue.DS1_INSTOREDEMO_QUIT);
            }
        }
        try {
            int result = this.mDsClient.setDsOnChecked(this.mPrevDsOnStat);
            if (result != 0) {
                Log.e(TAG, "DlbApController.restoreAllDs1Data, setDsOnChecked failed due to return code: " + result);
            } else {
                this.mDsClient.setSelectedProfile(this.mPrevProfile);
            }
        } catch (Exception e2) {
            Log.e(TAG, "DlbApController.restoreAllDs1Data,fail to call setDsOnChecked or setSelectedProfile or setIeqPreset");
            e2.printStackTrace();
            this.mHandler.sendEmptyMessage(ConstValue.DS1_INSTOREDEMO_QUIT);
        }
    }

    public boolean isDsConnected() {
        return this.mDsConnected;
    }

    public boolean processApMessage(Message msg) {
        Log.d(TAG, "processApMessage " + msg.what);
        if (msg.obj == null) {
            Log.e(TAG, "the msg.obj is null");
            return true;
        }
        AutoPilotItem apitem = (AutoPilotItem) msg.obj;
        boolean ret = handleMasterControl(apitem.getMasterControlValue());
        Log.d(TAG, "handleMasterControl, returns " + ret);
        if (!ret) {
            return false;
        }
        Log.d(TAG, "handleProfileControl, returns " + handleProfileControl(apitem.getProfileControlValue()));
        Log.d(TAG, "handleSurroundVirtualizer, returns " + handleSurroundVirtualizer(apitem.getSurroundVirtualizerValue()));
        Log.d(TAG, "handleDialogEnhancer, returns " + handleDialogEnhancer(apitem.getDialogEnahancerValue()));
        Log.d(TAG, "handleVolumeLeveler, returns " + handleVolumeLeveler(apitem.getVolumeLevelerValue()));
        Log.d(TAG, "handleIntelligentEq, returns " + handleIntelligentEq(apitem.getIntelligenEqValue()));
        handleTextInfo(apitem.getDisplayText());
        return true;
    }

    private void handleTextInfo(TextInfo ti) {
    }

    private boolean handleIntelligentEq(String sieq) {
        int ieq;
        Log.d(TAG, "handleIntelligentEq, ieq = " + sieq);
        if (sieq.equalsIgnoreCase("off")) {
            ieq = 0;
        } else if (sieq.equalsIgnoreCase("Open")) {
            ieq = 1;
        } else if (sieq.equalsIgnoreCase("Rich")) {
            ieq = 2;
        } else if (sieq.equalsIgnoreCase("Focused")) {
            ieq = 3;
        } else {
            if (sieq.equalsIgnoreCase("Warm")) {
                Log.d(TAG, "Not supported yet");
                return true;
            }
            if (sieq.equalsIgnoreCase("Bright")) {
                Log.d(TAG, "Not supported yet");
                return true;
            }
            if (sieq.equalsIgnoreCase("Balanced")) {
                Log.d(TAG, "Not supported yet");
                return true;
            }
            if (sieq.equalsIgnoreCase("unset")) {
                Log.d(TAG, "value does not change");
                return true;
            }
            Log.e(TAG, "DlbApController.handleIntelligentEq, invalid value = -1");
            return false;
        }
        try {
            int profile = this.mDsClient.getSelectedProfile();
            this.mDsClient.setIeqPreset(profile, ieq);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "DlbApController.handleIntelligentEq, fail to call setIeqPreset");
            e.printStackTrace();
            return false;
        }
    }

    private boolean handleVolumeLeveler(String vl) {
        boolean on;
        Log.d(TAG, "handleVolumeLeveler, vl = " + vl);
        if (vl.equalsIgnoreCase("on")) {
            on = true;
        } else if (vl.equalsIgnoreCase("off")) {
            on = false;
        } else {
            if (vl.equalsIgnoreCase("unset")) {
                Log.d(TAG, "value does not change");
                return true;
            }
            Log.e(TAG, "DlbApController.handleVolumeLeveler, invalid value = " + vl);
            return false;
        }
        try {
            int profile = this.mDsClient.getSelectedProfile();
            DsClientSettings dscs = this.mDsClient.getProfileSettings(profile);
            dscs.setVolumeLevellerOn(on);
            this.mDsClient.setProfileSettings(profile, dscs);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "DlbApController.handleVolumeLeveler,fail to call setProfileSettings");
            e.printStackTrace();
            return false;
        }
    }

    private boolean handleDialogEnhancer(String deh) {
        boolean on;
        Log.d(TAG, "handleDialogEnhancer, deh = " + deh);
        if (deh.equalsIgnoreCase("on")) {
            on = true;
        } else if (deh.equalsIgnoreCase("off")) {
            on = false;
        } else {
            if (deh.equalsIgnoreCase("unset")) {
                Log.d(TAG, "value does not change");
                return true;
            }
            Log.e(TAG, "DlbApController.handleDialogEnhancer, invalid value = " + deh);
            return false;
        }
        try {
            int profile = this.mDsClient.getSelectedProfile();
            DsClientSettings dscs = this.mDsClient.getProfileSettings(profile);
            dscs.setDialogEnhancerOn(on);
            this.mDsClient.setProfileSettings(profile, dscs);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "DlbApController.handleDialogEnhancer,fail to call setProfileSettings");
            e.printStackTrace();
            return false;
        }
    }

    private boolean handleSurroundVirtualizer(String sv) {
        boolean on;
        Log.d(TAG, "handleSurroundVirtualizer " + sv);
        if (sv.equalsIgnoreCase("on")) {
            on = true;
        } else if (sv.equalsIgnoreCase("off")) {
            on = false;
        } else {
            if (sv.equalsIgnoreCase("unset")) {
                Log.d(TAG, "value does not change");
                return true;
            }
            Log.e(TAG, "DlbApController.handleSurroundVirtualizer, invalid value = " + sv);
            return false;
        }
        try {
            DsClientSettings dscs = this.mDsClient.getProfileSettings(this.mDsClient.getSelectedProfile());
            dscs.setHeadphoneVirtualizerOn(on);
            this.mDsClient.setProfileSettings(this.mDsClient.getSelectedProfile(), dscs);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "DlbApController.handleSurroundVirtualizer,fail to call setProfileSettings");
            e.printStackTrace();
            return false;
        }
    }

    private boolean handleProfileControl(String proctl) {
        int profile;
        Log.d(TAG, "handleProfileControl, profilecontrol = " + proctl);
        if (proctl.equalsIgnoreCase("Movie")) {
            profile = 0;
        } else if (proctl.equalsIgnoreCase("Music")) {
            profile = 1;
        } else if (proctl.equalsIgnoreCase("Game")) {
            profile = 2;
        } else if (proctl.equalsIgnoreCase("Voice")) {
            profile = 3;
        } else {
            if (proctl.equalsIgnoreCase("unset")) {
                Log.d(TAG, "value not change!");
                return true;
            }
            Log.e(TAG, "DlbApController.handleProfileControl,invalid value = " + proctl);
            return false;
        }
        try {
            this.mDsClient.setSelectedProfile(profile);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "DlbApController.handleProfileControl,fail to call setProfileSettings");
            e.printStackTrace();
            return false;
        }
    }

    private boolean handleMasterControl(String mastercontrol) {
        boolean on;
        Log.d(TAG, "handleMasterControl, mastercontrol = " + mastercontrol);
        if (mastercontrol.equalsIgnoreCase("on")) {
            on = true;
        } else if (mastercontrol.equalsIgnoreCase("off")) {
            on = false;
        } else {
            if (mastercontrol.equalsIgnoreCase("unset")) {
                Log.d(TAG, "no need to handle this");
                return true;
            }
            Log.e(TAG, "DlbApController.handleMasterControl, invalid value = " + mastercontrol);
            return false;
        }
        try {
            int result = this.mDsClient.setDsOnChecked(on);
            if (result == 0) {
                return true;
            }
            Log.e(TAG, "DlbApController.handleMasterControl, setDsOnChecked failed due to return code: " + result);
            return false;
        } catch (Exception e) {
            Log.e(TAG, "DlbApController.handleMasterControl, setDsOnChecked failed");
            e.printStackTrace();
            return false;
        }
    }

    private void initMsgList() {
        if (this.mMsgList != null) {
            this.mMsgList.clear();
            this.mMsgList = null;
        }
        this.mMsgList = new ArrayList<>();
        ArrayList<AutoPilotItem> aplist = this.mApInfoExtractor.getAutoPilotMetadata();
        Log.d(TAG, "aplist.length = " + aplist.size());
        for (int i = 0; i < aplist.size(); i++) {
            AutoPilotItem apitem = aplist.get(i);
            Log.d(TAG, "obj of msg: \n" + apitem);
            Message msg = this.mHandler.obtainMessage(ConstValue.AP_MSG_ID, apitem);
            long delaytime = calMsgDelaytime(apitem.getTimeStamp()).longValue();
            APMessage apmsg = new APMessage(delaytime, msg);
            this.mMsgList.add(apmsg);
        }
    }

    private Integer calMsgDelaytime(String timestamp) {
        Integer.valueOf(0);
        int colonIdx = timestamp.indexOf(58);
        if (colonIdx == -1) {
            Log.e(TAG, "the format of the timestamp is not valid");
            return -1;
        }
        String sub = timestamp.substring(0, colonIdx);
        Log.d(TAG, "hour = " + sub);
        Integer hour = Integer.valueOf(sub);
        String tmp = timestamp.substring(colonIdx + 1, timestamp.length());
        int colonIdx2 = tmp.indexOf(58);
        String sub2 = tmp.substring(0, colonIdx2);
        Log.d(TAG, "min = " + sub2);
        Integer minute = Integer.valueOf(sub2);
        String tmp2 = tmp.substring(colonIdx2 + 1, tmp.length());
        int colonIdx3 = tmp2.indexOf(58);
        String sub3 = tmp2.substring(0, colonIdx3);
        Log.d(TAG, "sec = " + sub3);
        Integer second = Integer.valueOf(sub3);
        Integer millisecond = Integer.valueOf(tmp2.substring(colonIdx3 + 1, tmp2.length()));
        Integer ret = Integer.valueOf((hour.intValue() * 60 * 60 * 1000) + (minute.intValue() * 60 * 1000) + (second.intValue() * 1000) + millisecond.intValue());
        Log.d(TAG, "time = " + ret);
        return ret;
    }

    public void onClientConnected() {
        Log.d(TAG, "onClientConnected");
        this.mDsConnected = true;
        this.mHandler.sendEmptyMessage(ConstValue.DS1_SERVICE_CONNECTED);
    }

    public void onClientDisconnected() {
        Log.d(TAG, "onClientDisConnected");
    }

    public void onDsOn(boolean arg0) {
    }

    public void onProfileNameChanged(int arg0, String arg1) {
    }

    public void onProfileSelected(int arg0) {
    }

    public void onProfileSettingsChanged(int arg0) {
    }

    public void onEqSettingsChanged(int arg0, int arg1) {
    }
}
