package com.dolby;

/* JADX INFO: loaded from: classes.dex */
public class DsWidgetStatus {
    private static DsWidgetStatus instance_ = null;
    private boolean on_ = false;
    private int profile_ = 0;
    private String profileName_ = "";
    private boolean modified_ = false;

    private DsWidgetStatus() {
    }

    public static DsWidgetStatus getInstance() {
        if (instance_ == null) {
            instance_ = new DsWidgetStatus();
        }
        return instance_;
    }

    public void setOn(boolean on) {
        this.on_ = on;
    }

    public void setProfile(int profile) {
        this.profile_ = profile;
    }

    public void setModified(boolean mod) {
        this.modified_ = mod;
    }

    public void setProfileName(String profileName) {
        this.profileName_ = profileName;
    }

    public boolean getOn() {
        return this.on_;
    }

    public int getProfile() {
        return this.profile_;
    }

    public boolean getModified() {
        return this.modified_;
    }

    public String getProfileName() {
        return this.profileName_;
    }
}
