package com.dolby.instoredemoapp;

import android.util.Log;
import java.io.InputStream;
import java.util.ArrayList;

/* JADX INFO: loaded from: classes.dex */
public class DlbApInfoExtractor {
    private static final String TAG = "DlbApInfoExtractor";
    private InputStream mApInfoStream = null;
    private IAPMetadataParser mApParser = new DlbAPMetadataParser();

    public DlbApInfoExtractor() {
        Log.d(TAG, "Constructor");
    }

    public void setApInfoFile(InputStream apstream) {
        if (!apstream.equals(this.mApInfoStream)) {
            this.mApInfoStream = apstream;
            this.mApParser.parseFile(this.mApInfoStream);
        }
    }

    public String getTechInfo() {
        return this.mApParser.getTechInfo();
    }

    public String getFormatVersion() {
        return this.mApParser.getFormatVersion();
    }

    public ArrayList<AutoPilotItem> getAutoPilotMetadata() {
        return this.mApParser.getAutoPilotMetadata();
    }
}
