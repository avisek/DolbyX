package com.dolby.instoredemoapp;

/* JADX INFO: loaded from: classes.dex */
public class AutoPilotItem {
    private static String UNSET = "unset";
    private String mDialogEnhancer;
    private TextInfo mDisplayText;
    private int mId;
    private String mIntelligentEq;
    private String mMasterControl;
    private String mProfileControl;
    private String mSurroundVirtualizer;
    private String mTimeStamp;
    private String mVolumeLeveler;

    public AutoPilotItem(int id, String timestamp, TextInfo text, String mastercontrol, String profilecontrol, String surroundvirtualizer, String dialogenhancer, String volumeleveler, String intelligenteq) {
        this.mId = id;
        this.mTimeStamp = timestamp;
        this.mDisplayText = text;
        this.mMasterControl = mastercontrol;
        this.mProfileControl = profilecontrol;
        this.mSurroundVirtualizer = surroundvirtualizer;
        this.mDialogEnhancer = dialogenhancer;
        this.mVolumeLeveler = volumeleveler;
        this.mIntelligentEq = intelligenteq;
    }

    public AutoPilotItem() {
        this.mId = 0;
        this.mTimeStamp = UNSET;
        this.mDisplayText = new TextInfo();
        this.mDisplayText.text = "";
        this.mMasterControl = UNSET;
        this.mProfileControl = UNSET;
        this.mSurroundVirtualizer = UNSET;
        this.mDialogEnhancer = UNSET;
        this.mVolumeLeveler = UNSET;
        this.mIntelligentEq = UNSET;
    }

    public int getId() {
        return this.mId;
    }

    public void setId(int id) {
        this.mId = id;
    }

    public String getTimeStamp() {
        return this.mTimeStamp;
    }

    public void setTimeStamp(String timestamp) {
        this.mTimeStamp = timestamp;
    }

    public TextInfo getDisplayText() {
        return this.mDisplayText;
    }

    public void setDisplayText(TextInfo displaytext) {
        this.mDisplayText = displaytext;
    }

    public String getMasterControlValue() {
        return this.mMasterControl;
    }

    public void setMasterControlValue(String mastercontrol) {
        this.mMasterControl = mastercontrol;
    }

    public String getProfileControlValue() {
        return this.mProfileControl;
    }

    public void setProfileControlValue(String profilecontrol) {
        this.mProfileControl = profilecontrol;
    }

    public String getSurroundVirtualizerValue() {
        return this.mSurroundVirtualizer;
    }

    public void setSurroundVirtualizerValue(String surroundvirtualizer) {
        this.mSurroundVirtualizer = surroundvirtualizer;
    }

    public String getDialogEnahancerValue() {
        return this.mDialogEnhancer;
    }

    public void setDialogEnhancerValue(String dialogenhancer) {
        this.mDialogEnhancer = dialogenhancer;
    }

    public String getVolumeLevelerValue() {
        return this.mVolumeLeveler;
    }

    public void setVolumeLevelerValue(String volumeleveler) {
        this.mVolumeLeveler = volumeleveler;
    }

    public String getIntelligenEqValue() {
        return this.mIntelligentEq;
    }

    public void setIntelligentEqValue(String intelligenteq) {
        this.mIntelligentEq = intelligenteq;
    }

    public String toString() {
        new String();
        String ret = "id = " + Integer.valueOf(this.mId).toString() + "\ntimestamp = " + this.mTimeStamp + "\ntextinfo = " + this.mDisplayText + "\nmaster_control = " + this.mMasterControl + "\nprofile_control = " + this.mProfileControl + "\nsurround_virtualizer = " + this.mSurroundVirtualizer + "\ndialog_enhancer = " + this.mDialogEnhancer + "\nvolume_leveler = " + this.mVolumeLeveler + "\nintelligent_eq = " + this.mIntelligentEq + "\n";
        return ret;
    }
}
