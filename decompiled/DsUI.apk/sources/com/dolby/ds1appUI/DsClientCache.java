package com.dolby.ds1appUI;

import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.os.DeadObjectException;
import android.os.RemoteException;

/* JADX INFO: loaded from: classes.dex */
public class DsClientCache {
    public static final DsClientCache INSTANCE = new DsClientCache();
    private boolean mDsOn;
    private DsClientSettings[] mProfiles;
    private int mSelectedProfile = -1;

    private DsClientCache() {
    }

    public synchronized void reset() {
        this.mProfiles = null;
        this.mSelectedProfile = -1;
    }

    public synchronized DsClientSettings getSelectedProfileSettings(DsClient ds) throws UnsupportedOperationException, RemoteException {
        return getProfileSettings(ds, getSelectedProfile(ds));
    }

    public synchronized DsClientSettings getProfileSettings(DsClient ds, int profile) throws UnsupportedOperationException, RemoteException {
        if (this.mProfiles == null) {
            int profnumber = ds.getProfileCount();
            if (profnumber == 0) {
                throw new DeadObjectException();
            }
            this.mProfiles = new DsClientSettings[profnumber];
        }
        if (this.mProfiles[profile] == null) {
            this.mProfiles[profile] = ds.getProfileSettings(profile);
        }
        return this.mProfiles[profile];
    }

    public synchronized void setProfileSettings(DsClient ds, int profile, DsClientSettings settings) throws UnsupportedOperationException, RemoteException, IllegalArgumentException {
        ds.setProfileSettings(profile, settings);
        cacheProfileSettings(ds, profile, settings);
    }

    public synchronized void cacheProfileSettings(DsClient ds, int profile, DsClientSettings settings) throws UnsupportedOperationException, RemoteException {
        if (this.mProfiles == null) {
            this.mProfiles = new DsClientSettings[ds.getProfileCount()];
        }
        this.mProfiles[profile] = settings;
    }

    public synchronized int getSelectedProfile(DsClient ds) throws UnsupportedOperationException, RemoteException {
        if (this.mSelectedProfile == -1) {
            int profnumber = ds.getProfileCount();
            if (profnumber > 0) {
                this.mSelectedProfile = ds.getSelectedProfile();
            }
        }
        return this.mSelectedProfile;
    }

    public synchronized void cacheSelectedProfile(int selectedProfile) {
        this.mSelectedProfile = selectedProfile;
    }

    public synchronized void setSelectedProfile(DsClient ds, int profile) throws UnsupportedOperationException, RemoteException, IllegalArgumentException {
        ds.setSelectedProfile(profile);
        this.mProfiles[profile] = ds.getProfileSettings(profile);
        this.mSelectedProfile = profile;
    }

    public synchronized void cacheDsOn(boolean on) {
        this.mDsOn = on;
    }

    public boolean isDsOn() {
        return this.mDsOn;
    }
}
