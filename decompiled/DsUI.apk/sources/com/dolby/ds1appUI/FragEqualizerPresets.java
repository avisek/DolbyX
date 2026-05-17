package com.dolby.ds1appUI;

import android.app.Activity;
import android.app.DialogFragment;
import android.app.Fragment;
import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.dolby.IDsClientEvents;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.GridView;
import android.widget.ListAdapter;
import android.widget.TextView;
import com.dolby.ds1appCoreUI.Tag;
import com.dolby.ds1appUI.Assets;
import com.dolby.ds1appUI.EqualizerAdapter;

/* JADX INFO: loaded from: classes.dex */
public class FragEqualizerPresets extends Fragment implements View.OnClickListener, IEqualizerChangeListener, IDsClientEvents, View.OnLongClickListener {
    private static final int CUSTOM_EQ = 4;
    private static final int CUSTOM_EQ_MOBILE = 3;
    private static final int EQUALIZER_SETTING_CUSTOM = -1;
    private DsClient mDsClient;
    private EqualizerAdapter mEqualizerAdapter;
    private IDsFragObserver mFObserver;
    private GridView mIEqPresets;
    private View mQmIntEq;
    private IDsFragEqualizerPresetsObserver mSpecificObserver;
    private boolean mDolbyClientConnected = false;
    private boolean mMobileLayout = false;

    /* JADX WARN: Multi-variable type inference failed */
    @Override // android.app.Fragment
    public void onAttach(Activity activity) {
        super.onAttach(activity);
        try {
            this.mFObserver = (IDsFragObserver) activity;
            try {
                this.mSpecificObserver = (IDsFragEqualizerPresetsObserver) activity;
                this.mDsClient = this.mFObserver.getDsClient();
            } catch (ClassCastException e) {
                throw new ClassCastException(activity.toString() + " must implement IDsFragEqualizerPresetsObserver");
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
        View v = inflater.inflate(R.layout.fragequalizerpresets, container, false);
        this.mMobileLayout = getResources().getBoolean(R.bool.newLayout);
        int[] textIds = {R.id.equalizerLabel, R.id.equalizerName};
        for (int id : textIds) {
            TextView tv = (TextView) v.findViewById(id);
            if (tv != null) {
                if (this.mMobileLayout) {
                    tv.setTypeface(Assets.getFont(Assets.FontType.LIGHT));
                } else {
                    tv.setTypeface(Assets.getFont(Assets.FontType.REGULAR));
                }
            }
        }
        if (this.mMobileLayout) {
            TextView tv2 = (TextView) v.findViewById(R.id.equalizerName);
            if (tv2 != null) {
                tv2.setTypeface(Assets.getFont(Assets.FontType.MEDIUM));
            }
            TextView tv3 = (TextView) v.findViewById(R.id.equalizerLabel);
            if (tv3 != null) {
                tv3.setOnLongClickListener(this);
            }
        }
        this.mIEqPresets = (GridView) v.findViewById(R.id.equalizerListView);
        if (this.mIEqPresets != null) {
            this.mEqualizerAdapter = new EqualizerAdapter(getActivity(), R.layout.equalizer_list_item, new EqualizerAdapter.IPresetListener() { // from class: com.dolby.ds1appUI.FragEqualizerPresets.1
                @Override // com.dolby.ds1appUI.EqualizerAdapter.IPresetListener
                public void onPresetChanged(int position) {
                    FragEqualizerPresets.this.chooseEqualizerSettinginUI(position);
                }
            });
            this.mIEqPresets.setAdapter((ListAdapter) this.mEqualizerAdapter);
            this.mIEqPresets.setOnTouchListener(new View.OnTouchListener() { // from class: com.dolby.ds1appUI.FragEqualizerPresets.2
                @Override // android.view.View.OnTouchListener
                public boolean onTouch(View v2, MotionEvent event) {
                    if (event.getAction() != 2 || !FragEqualizerPresets.this.mIEqPresets.isEnabled()) {
                        return false;
                    }
                    FragEqualizerPresets.this.mEqualizerAdapter.scheduleNotifyDataSetChanged();
                    return true;
                }
            });
        }
        View theV = v.findViewById(R.id.equalizerCustom);
        if (theV != null) {
            theV.setOnClickListener(this);
            theV.setSoundEffectsEnabled(false);
        }
        View theV2 = v.findViewById(R.id.eqResetButton);
        if (theV2 != null) {
            theV2.setOnClickListener(this);
            theV2.setSoundEffectsEnabled(false);
        }
        this.mQmIntEq = v.findViewById(R.id.qm_inteq);
        if (this.mQmIntEq != null) {
            this.mQmIntEq.setOnClickListener(this);
            this.mQmIntEq.setSoundEffectsEnabled(false);
        }
        return v;
    }

    @Override // android.app.Fragment
    public void onActivityCreated(Bundle savedInstanceState) {
        super.onActivityCreated(savedInstanceState);
    }

    @Override // android.app.Fragment
    public void onStart() {
        super.onStart();
        if (this.mMobileLayout) {
            this.mSpecificObserver.equalizerPresetsAreAlive();
        }
    }

    @Override // android.view.View.OnClickListener
    public void onClick(View view) {
        int id = view.getId();
        if (R.id.qm_inteq == id) {
            this.mSpecificObserver.displayTooltip(view, R.string.tooltip_eq_title, R.string.tooltip_eq_text);
        } else {
            onDolbyClientUseClick(view);
        }
    }

    @Override // com.dolby.ds1appUI.IEqualizerChangeListener
    public void onEqualizerEditStart() {
        setResetEqButtonVisibility();
        this.mSpecificObserver.onEqualizerEditStart();
    }

    public void onClientConnected() {
        this.mDolbyClientConnected = true;
    }

    public void onClientDisconnected() {
        this.mDolbyClientConnected = false;
    }

    public void onDsOn(boolean on) {
    }

    public void onProfileSelected(int profile) {
    }

    public void onProfileSettingsChanged(int profile) {
    }

    public void onProfileNameChanged(int profile, String name) {
    }

    public void onEqSettingsChanged(int profile, int preset) {
        try {
            DsClientSettings settings = this.mDsClient.getProfileSettings(profile);
            DsClientCache.INSTANCE.cacheProfileSettings(this.mDsClient, profile, settings);
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
            if (profile == selectedProfile) {
                setResetEqButtonVisibility();
                selectIEqPresetInUI(preset - 1);
            }
        } catch (Exception e) {
            e.printStackTrace();
            this.mFObserver.onDsApiError();
        }
    }

    public void setEnabled(boolean on) {
        if (this.mIEqPresets != null) {
            this.mIEqPresets.setEnabled(on);
            this.mEqualizerAdapter.setDolbyOnOff(on);
            this.mEqualizerAdapter.scheduleNotifyDataSetChanged();
        }
        View theFragV = getView();
        View v = theFragV.findViewById(R.id.equalizerLabel);
        if (v != null) {
            v.setEnabled(on);
        }
        View v2 = theFragV.findViewById(R.id.equalizerName);
        if (v2 != null) {
            v2.setEnabled(on);
        }
        View v3 = theFragV.findViewById(R.id.equalizerCustom);
        if (v3 != null) {
            v3.setEnabled(on);
            v3.setSoundEffectsEnabled(false);
        }
        View v4 = theFragV.findViewById(R.id.eqListFrame);
        if (v4 != null) {
            v4.setEnabled(on);
            v4.setSoundEffectsEnabled(false);
        }
        if (this.mQmIntEq != null) {
            this.mQmIntEq.setEnabled(on);
        }
        setResetEqButtonVisibility();
    }

    public void selectIEqPresetInUI(int preset) {
        if (this.mMobileLayout && preset == -1) {
            preset = 3;
        }
        View v = getView();
        this.mEqualizerAdapter.setSelection(preset);
        if (!this.mMobileLayout) {
            try {
                DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                View theV = v.findViewById(R.id.equalizerCustom);
                if (theV != null) {
                    theV.setSelected(preset == -1);
                }
                TextView eqText = (TextView) v.findViewById(R.id.equalizerLabel);
                if (eqText != null) {
                    eqText.setText(preset == -1 ? getString(R.string.graphical_equalizer) : getString(R.string.intelligent_equalizer));
                }
                TextView tv = (TextView) v.findViewById(R.id.equalizerName);
                if (tv != null && this.mEqualizerAdapter != null) {
                    tv.setText(preset == -1 ? getString(R.string.custom) : this.mEqualizerAdapter.getItem(preset).getName());
                }
            } catch (Exception e) {
                e.printStackTrace();
                this.mFObserver.onDsApiError();
                return;
            }
        } else {
            TextView eqText2 = (TextView) v.findViewById(R.id.equalizerLabel);
            if (eqText2 != null) {
                eqText2.setText(preset == 3 ? getString(R.string.graphical_equalizer) : getString(R.string.intelligent_equalizer));
            }
            TextView tv2 = (TextView) v.findViewById(R.id.equalizerName);
            if (tv2 != null && this.mEqualizerAdapter != null) {
                tv2.setText(this.mEqualizerAdapter.getItem(preset).getName());
            }
        }
        updateGraphicEqInUI();
    }

    public void setResetEqButtonVisibility() {
        DsClientSettings profile = null;
        int vis = 4;
        try {
            if (DsClientCache.INSTANCE.isDsOn()) {
                int n = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                if (n != -1) {
                    profile = DsClientCache.INSTANCE.getProfileSettings(this.mDsClient, n);
                }
                if (profile != null) {
                    if (profile.getGeqOn()) {
                        vis = 0;
                    }
                }
            }
            View theV = getView().findViewById(R.id.eqResetButton);
            if (theV != null) {
                theV.setVisibility(vis);
            }
        } catch (Exception e) {
            e.printStackTrace();
            this.mFObserver.onDsApiError();
        }
    }

    public void updateGraphicEqInUI() {
        try {
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
            if (selectedProfile != -1) {
                DsClientSettings profile = DsClientCache.INSTANCE.getProfileSettings(this.mDsClient, selectedProfile);
                if (profile != null) {
                    setResetEqButtonVisibility();
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
            this.mFObserver.onDsApiError();
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public void chooseEqualizerSettinginUI(int preset) {
        Log.d(Tag.MAIN, "chooseEqualizerSetting " + preset);
        if (this.mMobileLayout && preset == 3) {
            preset = -1;
        }
        if (this.mDolbyClientConnected) {
            try {
                int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                Log.d(Tag.MAIN, "mDsClient.setIeqPreset " + (preset + 1));
                try {
                    this.mDsClient.setIeqPreset(selectedProfile, preset + 1);
                    DsClientSettings updated = this.mDsClient.getProfileSettings(selectedProfile);
                    DsClientCache.INSTANCE.cacheProfileSettings(this.mDsClient, selectedProfile, updated);
                    selectIEqPresetInUI(preset);
                    setResetEqButtonVisibility();
                    chooseEqualizerSetting(preset);
                } catch (Exception e) {
                    e.printStackTrace();
                    this.mFObserver.onDsApiError();
                }
            } catch (Exception e2) {
                e2.printStackTrace();
                this.mFObserver.onDsApiError();
            }
        }
    }

    private void chooseEqualizerSetting(int preset) {
        if (this.mDolbyClientConnected) {
            if (this.mMobileLayout && preset == 3) {
                preset = -1;
            }
            selectIEqPresetInUI(preset);
            try {
                int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                try {
                    DsClientSettings selectedProfileSettings = DsClientCache.INSTANCE.getProfileSettings(this.mDsClient, selectedProfile);
                    this.mSpecificObserver.setUserProfilePopulated();
                    updateGraphicEqInUI();
                    this.mSpecificObserver.onProfileSettingsChanged(selectedProfile, selectedProfileSettings);
                } catch (Exception e) {
                    e.printStackTrace();
                    this.mFObserver.onDsApiError();
                }
            } catch (Exception e2) {
                e2.printStackTrace();
                this.mFObserver.onDsApiError();
            }
        }
    }

    private void onDolbyClientUseClick(View view) {
        if (this.mDolbyClientConnected && ((IDsActivityCommonTemp) getActivity()).useDsApiOnUiEvent()) {
            try {
                int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                DsClientSettings selectedProfileSettings = DsClientCache.INSTANCE.getProfileSettings(this.mDsClient, selectedProfile);
                int id = view.getId();
                if (R.id.equalizerCustom == id) {
                    chooseEqualizerSettinginUI(-1);
                    TextView eqText = (TextView) getView().findViewById(R.id.equalizerLabel);
                    eqText.setText(R.string.graphical_equalizer);
                } else if (R.id.eqResetButton == id) {
                    resetGEqOnUserClick(selectedProfile, selectedProfileSettings);
                }
            } catch (Exception e) {
                e.printStackTrace();
                this.mFObserver.onDsApiError();
            }
        }
    }

    private void resetGEqOnUserClick(int selectedProfile, DsClientSettings selectedProfileSettings) {
        this.mSpecificObserver.resetEqUserGains();
        this.mSpecificObserver.onProfileSettingsChanged(selectedProfile, selectedProfileSettings);
    }

    @Override // android.view.View.OnLongClickListener
    public boolean onLongClick(View v) {
        if (!this.mMobileLayout) {
            return false;
        }
        DialogFragment diag = TooltipDialog.newInstance(R.string.tooltip_eq_title, R.string.tooltip_eq_text);
        diag.setShowsDialog(true);
        diag.show(getFragmentManager(), "TooltipDialog");
        return true;
    }
}
