package com.dolby.ds1appUI;

import android.app.Activity;
import android.app.Fragment;
import android.dolby.DsClient;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;

/* JADX INFO: loaded from: classes.dex */
public class FragPower extends Fragment implements View.OnClickListener {
    private static final String TAG = "FragPower";
    private DsClient mDsClient;
    private IDsFragObserver mFObserver;
    private ImageView mImgoff;
    private ImageView mImgon;
    private IDsFragPowerObserver mSpecificObserver;

    /* JADX WARN: Multi-variable type inference failed */
    @Override // android.app.Fragment
    public void onAttach(Activity activity) {
        super.onAttach(activity);
        try {
            this.mFObserver = (IDsFragObserver) activity;
            try {
                this.mSpecificObserver = (IDsFragPowerObserver) activity;
                this.mDsClient = this.mFObserver.getDsClient();
            } catch (ClassCastException e) {
                throw new ClassCastException(activity.toString() + " must implement IDsFragPowerObserver");
            }
        } catch (ClassCastException e2) {
            throw new ClassCastException(activity.toString() + " must implement IDsFragObserver");
        }
    }

    @Override // android.app.Fragment
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override // android.app.Fragment
    public View onCreateView(LayoutInflater inflater, ViewGroup container, Bundle savedInstanceState) {
        View v = inflater.inflate(R.layout.fragpower, container, false);
        this.mImgon = (ImageView) v.findViewById(R.id.powerButtonOn);
        this.mImgoff = (ImageView) v.findViewById(R.id.powerButtonOff);
        this.mImgon.setOnClickListener(this);
        this.mImgon.setSoundEffectsEnabled(false);
        this.mImgoff.setOnClickListener(this);
        this.mImgoff.setSoundEffectsEnabled(false);
        return v;
    }

    /* JADX WARN: Unsupported multi-entry loop pattern (BACK_EDGE: B:17:0x004d -> B:18:0x0038). Please report as a decompilation issue!!! */
    @Override // android.view.View.OnClickListener
    public void onClick(View view) {
        int id = view.getId();
        if (R.id.powerButtonOn == id || R.id.powerButtonOff == id) {
            try {
                boolean on = !DsClientCache.INSTANCE.isDsOn();
                int result = this.mDsClient.setDsOnChecked(on);
                if (result != 0) {
                    Log.e(TAG, "FragPower.onClick, setDsOnChecked failed due to return code: " + result);
                } else {
                    DsClientCache.INSTANCE.cacheDsOn(this.mDsClient.getDsOn());
                    this.mSpecificObserver.onDsClientUseChanged(true);
                }
            } catch (Exception e) {
                e.printStackTrace();
                this.mFObserver.onDsApiError();
            }
        }
    }

    public void setEnabled(boolean on) {
        this.mImgon.setVisibility(on ? 0 : 4);
    }
}
