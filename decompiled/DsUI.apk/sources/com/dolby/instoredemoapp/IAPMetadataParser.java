package com.dolby.instoredemoapp;

import java.io.InputStream;
import java.util.ArrayList;

/* JADX INFO: loaded from: classes.dex */
public interface IAPMetadataParser {
    ArrayList<AutoPilotItem> getAutoPilotMetadata();

    String getFormatVersion();

    String getTechInfo();

    void parseFile(InputStream inputStream);
}
