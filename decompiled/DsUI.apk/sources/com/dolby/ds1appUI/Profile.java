package com.dolby.ds1appUI;

/* JADX INFO: loaded from: classes.dex */
public class Profile {
    private int mIconDisabled;
    private int mIconNormal;
    private int mIconSelected;

    public Profile(int iconSelected, int iconNormal, int iconDisabled) {
        this.mIconSelected = iconSelected;
        this.mIconNormal = iconNormal;
        this.mIconDisabled = iconDisabled;
    }

    public int getIcon(boolean selected, boolean enabled) {
        return selected ? this.mIconSelected : enabled ? this.mIconNormal : this.mIconDisabled;
    }
}
