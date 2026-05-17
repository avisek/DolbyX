package com.dolby.ds1appUI;

import android.app.Activity;
import android.app.DialogFragment;
import android.app.Fragment;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.media.AudioManager;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.ToggleButton;
import com.dolby.ds1appUI.Assets;

/* JADX INFO: loaded from: classes.dex */
public class FragSwitches extends Fragment implements View.OnClickListener, View.OnLongClickListener {
    private Activity mActivity;
    private DsClient mDsClient;
    private IDsFragObserver mFObserver;
    private IDsFragSwitchesObserver mSpecificObserver;
    private ToggleButton mdeButton;
    private TextView mdeText;
    private ImageView mqm_de;
    private ImageView mqm_sv;
    private ImageView mqm_vl;
    private ToggleButton msvButton;
    private TextView msvText;
    private ToggleButton mvlButton;
    private TextView mvlText;
    private boolean mMobileLayout = false;
    int mHeadset_plug = 0;
    private int mA2dpConnectionState = 0;
    private final BroadcastReceiver mReceiver = new BroadcastReceiver() { // from class: com.dolby.ds1appUI.FragSwitches.1
        @Override // android.content.BroadcastReceiver
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            Bundle bun = intent.getExtras();
            if ("android.intent.action.HEADSET_PLUG".equals(action)) {
                FragSwitches.this.mHeadset_plug = bun.getInt("state");
                DsClientSettings selectedProfileSettings = null;
                try {
                    int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(FragSwitches.this.mDsClient);
                    selectedProfileSettings = DsClientCache.INSTANCE.getProfileSettings(FragSwitches.this.mDsClient, selectedProfile);
                } catch (Exception e) {
                    e.printStackTrace();
                }
                if (selectedProfileSettings != null) {
                    FragSwitches.this.msvButton.setChecked(FragSwitches.this.getVirtualizer(selectedProfileSettings));
                    FragSwitches.this.setEnabled(FragSwitches.this.mdeButton.isEnabled());
                    return;
                }
                return;
            }
            if ("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED".equals(action)) {
                FragSwitches.this.mA2dpConnectionState = intent.getIntExtra("android.bluetooth.profile.extra.STATE", 0);
                DsClientSettings selectedProfileSettings2 = null;
                try {
                    int selectedProfile2 = DsClientCache.INSTANCE.getSelectedProfile(FragSwitches.this.mDsClient);
                    selectedProfileSettings2 = DsClientCache.INSTANCE.getProfileSettings(FragSwitches.this.mDsClient, selectedProfile2);
                } catch (Exception e2) {
                    e2.printStackTrace();
                }
                if (selectedProfileSettings2 != null) {
                    FragSwitches.this.msvButton.setChecked(FragSwitches.this.getVirtualizer(selectedProfileSettings2));
                    FragSwitches.this.setEnabled(FragSwitches.this.mdeButton.isEnabled());
                }
            }
        }
    };

    /* JADX WARN: Multi-variable type inference failed */
    @Override // android.app.Fragment
    public void onAttach(Activity activity) {
        super.onAttach(activity);
        this.mActivity = activity;
        try {
            this.mFObserver = (IDsFragObserver) activity;
            try {
                this.mSpecificObserver = (IDsFragSwitchesObserver) activity;
                this.mDsClient = this.mFObserver.getDsClient();
                AudioManager am = (AudioManager) this.mActivity.getSystemService("audio");
                this.mA2dpConnectionState = am.isBluetoothA2dpOn() ? 2 : 0;
                IntentFilter headsetFilter = new IntentFilter();
                headsetFilter.addAction("android.intent.action.HEADSET_PLUG");
                headsetFilter.addAction("android.bluetooth.a2dp.profile.action.CONNECTION_STATE_CHANGED");
                this.mActivity.registerReceiver(this.mReceiver, headsetFilter);
            } catch (ClassCastException e) {
                throw new ClassCastException(activity.toString() + " must implement IDsFragSwitchesObserver");
            }
        } catch (ClassCastException e2) {
            throw new ClassCastException(activity.toString() + " must implement IDsFragObserver");
        }
    }

    @Override // android.app.Fragment
    public void onDestroy() {
        super.onDestroy();
        this.mActivity.unregisterReceiver(this.mReceiver);
    }

    @Override // android.app.Fragment
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override // android.app.Fragment
    public View onCreateView(LayoutInflater inflater, ViewGroup container, Bundle savedInstanceState) {
        View v = inflater.inflate(R.layout.fragswitches, container, false);
        this.mMobileLayout = getResources().getBoolean(R.bool.newLayout);
        int[] textIds = {R.id.svText, R.id.deText, R.id.vlText};
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
        ToggleSlideListener slideListener = new ToggleSlideListener();
        int[] buttonids = {R.id.svButton, R.id.deButton, R.id.vlButton};
        for (int bid : buttonids) {
            View v2 = v.findViewById(bid);
            if (v2 != null) {
                v2.setOnClickListener(this);
                v2.setSoundEffectsEnabled(false);
                v2.setOnTouchListener(slideListener);
                if (this.mMobileLayout) {
                    v2.setOnLongClickListener(this);
                }
            }
        }
        this.mqm_sv = (ImageView) v.findViewById(R.id.qm_sv);
        this.mqm_de = (ImageView) v.findViewById(R.id.qm_de);
        this.mqm_vl = (ImageView) v.findViewById(R.id.qm_vl);
        this.msvButton = (ToggleButton) v.findViewById(R.id.svButton);
        this.mdeButton = (ToggleButton) v.findViewById(R.id.deButton);
        this.mvlButton = (ToggleButton) v.findViewById(R.id.vlButton);
        this.msvText = (TextView) v.findViewById(R.id.svText);
        this.mdeText = (TextView) v.findViewById(R.id.deText);
        this.mvlText = (TextView) v.findViewById(R.id.vlText);
        View[] viewobj = {this.mqm_sv, this.mqm_de, this.mqm_vl};
        for (View iv : viewobj) {
            if (iv != null) {
                iv.setOnClickListener(this);
                iv.setSoundEffectsEnabled(false);
            }
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
            this.mSpecificObserver.switchesAreAlive();
        }
    }

    @Override // android.view.View.OnClickListener
    public void onClick(View view) {
        int id = view.getId();
        try {
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
            DsClientSettings selectedProfileSettings = DsClientCache.INSTANCE.getProfileSettings(this.mDsClient, selectedProfile);
            switch (id) {
                case R.id.vlButton /* 2131361813 */:
                    this.mvlButton.cancelLongPress();
                    selectedProfileSettings.setVolumeLevellerOn(selectedProfileSettings.getVolumeLevellerOn() ? false : true);
                    this.mSpecificObserver.setUserProfilePopulated();
                    DsClientCache.INSTANCE.setProfileSettings(this.mDsClient, selectedProfile, selectedProfileSettings);
                    break;
                case R.id.deButton /* 2131361815 */:
                    this.mdeButton.cancelLongPress();
                    selectedProfileSettings.setDialogEnhancerOn(selectedProfileSettings.getDialogEnhancerOn() ? false : true);
                    this.mSpecificObserver.setUserProfilePopulated();
                    DsClientCache.INSTANCE.setProfileSettings(this.mDsClient, selectedProfile, selectedProfileSettings);
                    this.mSpecificObserver.onProfileSettingsChanged(selectedProfile, selectedProfileSettings);
                    break;
                case R.id.svButton /* 2131361817 */:
                    if (this.mHeadset_plug == 0 && this.mA2dpConnectionState != 2 && ((MainActivity) this.mActivity).isMonoSpeaker()) {
                        this.msvButton.setChecked(false);
                        return;
                    }
                    updateSVButtonImage(this.msvText.isEnabled(), this.msvText.getLayoutDirection());
                    this.msvButton.cancelLongPress();
                    setVirtualizer(selectedProfileSettings, this.msvButton.isChecked());
                    this.mSpecificObserver.setUserProfilePopulated();
                    DsClientCache.INSTANCE.setProfileSettings(this.mDsClient, selectedProfile, selectedProfileSettings);
                    this.mSpecificObserver.onProfileSettingsChanged(selectedProfile, selectedProfileSettings);
                    break;
                    break;
                case R.id.qm_sv /* 2131361818 */:
                    this.mSpecificObserver.displayTooltip(view, R.string.tooltip_sv_title, R.string.tooltip_sv_text);
                    break;
                case R.id.qm_de /* 2131361820 */:
                    this.mSpecificObserver.displayTooltip(view, R.string.tooltip_de_title, R.string.tooltip_de_text);
                    break;
                case R.id.qm_vl /* 2131361822 */:
                    this.mSpecificObserver.displayTooltip(view, R.string.tooltip_vl_title, R.string.tooltip_vl_text);
                    break;
            }
            this.mSpecificObserver.onProfileSettingsChanged(selectedProfile, selectedProfileSettings);
        } catch (Exception e) {
            e.printStackTrace();
            this.mFObserver.onDsApiError();
        }
    }

    private void setVirtualizer(DsClientSettings selectedProfileSettings, boolean on) {
        boolean isMonoSpeaker = ((MainActivity) this.mActivity).isMonoSpeaker();
        if ((this.mA2dpConnectionState == 2 || this.mHeadset_plug == 1 || !isMonoSpeaker) && this.msvButton != null) {
            this.msvButton.setEnabled(true);
        }
        if (this.mHeadset_plug == 1 || this.mA2dpConnectionState == 2) {
            selectedProfileSettings.setHeadphoneVirtualizerOn(on);
        } else if (isMonoSpeaker) {
            selectedProfileSettings.setSpeakerVirtualizerOn(false);
        } else {
            selectedProfileSettings.setSpeakerVirtualizerOn(on);
        }
    }

    /* JADX INFO: Access modifiers changed from: private */
    public boolean getVirtualizer(DsClientSettings selectedProfileSettings) {
        if (selectedProfileSettings.getSpeakerVirtualizerOn() && ((MainActivity) this.mActivity).isMonoSpeaker()) {
            selectedProfileSettings.setSpeakerVirtualizerOn(false);
        }
        return (this.mHeadset_plug == 1 || this.mA2dpConnectionState == 2) ? selectedProfileSettings.getHeadphoneVirtualizerOn() : selectedProfileSettings.getSpeakerVirtualizerOn();
    }

    public void onProfileSettingsChanged(DsClientSettings settings) {
        if (this.msvButton != null) {
            this.msvButton.setChecked(getVirtualizer(settings));
            updateSVButtonImage(this.msvText.isEnabled(), this.msvText.getLayoutDirection());
        }
        if (this.mdeButton != null) {
            this.mdeButton.setChecked(settings.getDialogEnhancerOn());
        }
        if (this.mvlButton != null) {
            this.mvlButton.setChecked(settings.getVolumeLevellerOn());
        }
    }

    public void updateSVButtonImage(boolean enabled, int direction) {
        if (enabled) {
            if (this.msvButton.isChecked()) {
                if (1 == direction) {
                    this.msvButton.setBackgroundResource(R.drawable.switchon_ldrtl);
                    return;
                } else {
                    this.msvButton.setBackgroundResource(R.drawable.switchon);
                    return;
                }
            }
            if (1 == direction) {
                this.msvButton.setBackgroundResource(R.drawable.switchoff_ldrtl);
                return;
            } else {
                this.msvButton.setBackgroundResource(R.drawable.switchoff);
                return;
            }
        }
        if (1 == direction) {
            this.msvButton.setBackgroundResource(R.drawable.switchdis_ldrtl);
        } else {
            this.msvButton.setBackgroundResource(R.drawable.switchdis);
        }
    }

    public void setEnabled(boolean on) {
        if (this.msvButton != null) {
            this.msvText.setEnabled(on);
            updateSVButtonImage(this.msvText.isEnabled(), this.msvText.getLayoutDirection());
            if (this.mHeadset_plug == 0 && this.mA2dpConnectionState != 2 && ((MainActivity) this.mActivity).isMonoSpeaker()) {
                this.msvText.setEnabled(false);
                this.msvButton.setChecked(false);
                updateSVButtonImage(this.msvText.isEnabled(), this.msvText.getLayoutDirection());
            }
        }
        View[] viewobj = {this.mdeButton, this.mvlButton, this.mdeText, this.mvlText, this.mqm_sv, this.mqm_de, this.mqm_vl};
        for (View iv : viewobj) {
            if (iv != null) {
                iv.setEnabled(on);
            }
        }
    }

    @Override // android.view.View.OnLongClickListener
    public boolean onLongClick(View v) {
        if (!this.mMobileLayout) {
            return false;
        }
        DialogFragment diag = null;
        if (v == this.mvlButton) {
            diag = TooltipDialog.newInstance(R.string.tooltip_vl_title, R.string.tooltip_vl_text);
        }
        if (v == this.mdeButton) {
            diag = TooltipDialog.newInstance(R.string.tooltip_de_title, R.string.tooltip_de_text);
        }
        if (v == this.msvButton) {
            diag = TooltipDialog.newInstance(R.string.tooltip_sv_title, R.string.tooltip_sv_text);
        }
        diag.show(getFragmentManager(), "TooltipDialog");
        return true;
    }
}
