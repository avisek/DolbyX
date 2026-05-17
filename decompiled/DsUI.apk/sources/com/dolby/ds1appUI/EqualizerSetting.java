package com.dolby.ds1appUI;

/* JADX INFO: loaded from: classes.dex */
public class EqualizerSetting {
    private int mIconDisabled;
    private int mIconNormal;
    private int mIconSelected;
    private String mName;

    public EqualizerSetting(String name, int iconSelected, int iconNormal, int iconDisabled) {
        this.mName = name;
        this.mIconSelected = iconSelected;
        this.mIconNormal = iconNormal;
        this.mIconDisabled = iconDisabled;
    }

    public String getName() {
        return this.mName;
    }

    public int getIcon(boolean selected, boolean enabled) {
        return enabled ? selected ? this.mIconSelected : this.mIconNormal : this.mIconDisabled;
    }
}
