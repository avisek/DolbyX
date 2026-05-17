package com.dolby.ds1appUI;

import android.app.Activity;
import android.app.Fragment;
import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.dolby.IDsClientEvents;
import android.os.Bundle;
import android.text.InputFilter;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;
import com.dolby.ds1appCoreUI.DS1Application;
import com.dolby.ds1appCoreUI.Tools;
import com.dolby.ds1appUI.Assets;

/* JADX INFO: loaded from: classes.dex */
public class FragProfilePresetEditor extends Fragment implements View.OnClickListener, View.OnLongClickListener, TextView.OnEditorActionListener, View.OnKeyListener, IDsClientEvents {
    private ProfileEditInfo mCurrentlyEditedProfile;
    private DsClient mDsClient;
    private IDsFragObserver mFObserver;
    private IDsFragProfileEditorObserver mSpecificObserver;
    private boolean mDolbyClientConnected = false;
    private boolean mMobileLayout = false;

    /* JADX WARN: Multi-variable type inference failed */
    @Override // android.app.Fragment
    public void onAttach(Activity activity) {
        super.onAttach(activity);
        try {
            this.mFObserver = (IDsFragObserver) activity;
            try {
                this.mSpecificObserver = (IDsFragProfileEditorObserver) activity;
                this.mDsClient = this.mFObserver.getDsClient();
            } catch (ClassCastException e) {
                throw new ClassCastException(activity.toString() + " must implement IDsFragProfileEditorObserver");
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
        View v = inflater.inflate(R.layout.fragprofileeditor, container, false);
        int[] textIds = {R.id.presetName};
        for (int id : textIds) {
            TextView tv = (TextView) v.findViewById(id);
            if (tv != null) {
                tv.setTypeface(Assets.getFont(Assets.FontType.REGULAR));
            }
        }
        View theV = v.findViewById(R.id.presetName);
        if (theV != null) {
            theV.setOnLongClickListener(this);
        }
        View theV2 = v.findViewById(R.id.revertButtonMain);
        if (theV2 != null) {
            theV2.setOnClickListener(this);
        }
        this.mMobileLayout = getResources().getBoolean(R.bool.newLayout);
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
            this.mSpecificObserver.profileEditorIsAlive();
        }
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
        View temp;
        TextView tv;
        setResetProfileVisibility();
        try {
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
            if (profile == selectedProfile && (temp = getView()) != null && (tv = (TextView) temp.findViewById(R.id.presetName)) != null) {
                tv.setText(name);
            }
        } catch (Exception e) {
            e.printStackTrace();
            this.mFObserver.onDsApiError();
        }
    }

    public void onEqSettingsChanged(int profile, int preset) {
        try {
            DsClientSettings settings = this.mDsClient.getProfileSettings(profile);
            DsClientCache.INSTANCE.cacheProfileSettings(this.mDsClient, profile, settings);
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
            if (profile == selectedProfile) {
                setResetProfileVisibility();
            }
        } catch (Exception e) {
            e.printStackTrace();
            this.mFObserver.onDsApiError();
        }
    }

    @Override // android.view.View.OnLongClickListener
    public boolean onLongClick(View view) {
        if (view.getId() == R.id.presetName) {
            startEditingProfileName((TextView) view, (EditText) getView().findViewById(R.id.presetNameEdit), this.mSpecificObserver.getProfileSelected() + 1);
            return true;
        }
        return true;
    }

    @Override // android.view.View.OnClickListener
    public void onClick(View view) {
        onDolbyClientUseClick(view);
    }

    @Override // android.widget.TextView.OnEditorActionListener
    public boolean onEditorAction(TextView view, int actionId, KeyEvent event) {
        if (view.getId() != R.id.presetNameEdit || ((actionId != 6 && actionId != 5 && actionId != 7) || (event != null && (event.getAction() != 0 || event.getKeyCode() != 66)))) {
            return false;
        }
        endEditingProfileName(true);
        return true;
    }

    @Override // android.view.View.OnKeyListener
    public boolean onKey(View view, int keyCode, KeyEvent event) {
        if (view.getId() != R.id.presetNameEdit || event.getAction() != 0 || event.getKeyCode() != 4) {
            return false;
        }
        endEditingProfileName(false);
        return true;
    }

    public void setEnabled(boolean on) {
        View theFragV = getView();
        if (!on) {
            endEditingProfileName(true);
        }
        setResetProfileVisibility();
        TextView tv = (TextView) theFragV.findViewById(R.id.presetName);
        if (tv != null) {
            if (!on) {
                tv.setText(R.string.off);
            }
            tv.setEnabled(on);
        }
        View v = theFragV.findViewById(R.id.revertButtonMain);
        if (v != null) {
            v.setVisibility(on ? 0 : 4);
        }
    }

    public void setResetProfileVisibility() {
        if (this.mDolbyClientConnected) {
            try {
                int profile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                boolean modified = this.mDsClient.isProfileModified(profile);
                String profileName = "";
                switch (profile) {
                    case 0:
                        profileName = getString(R.string.movie);
                        break;
                    case 1:
                        profileName = getString(R.string.music);
                        break;
                    case 2:
                        profileName = getString(R.string.game);
                        break;
                    case 3:
                        profileName = getString(R.string.voice);
                        break;
                    case 4:
                        profileName = getString(R.string.preset_1);
                        break;
                    case 5:
                        profileName = getString(R.string.preset_2);
                        break;
                }
                if (profile >= 4) {
                    try {
                        int cmf = DS1Application.getCustomModifyFlag(getActivity());
                        if (5 == profile + 1) {
                            if (1 == (cmf & 1)) {
                                modified |= true;
                                profileName = this.mDsClient.getProfileNames()[profile];
                            }
                        } else if (6 == profile + 1 && 2 == (cmf & 2)) {
                            modified |= true;
                            profileName = this.mDsClient.getProfileNames()[profile];
                        }
                    } catch (Exception e) {
                        e.printStackTrace();
                        this.mFObserver.onDsApiError();
                        return;
                    }
                }
                TextView tv = (TextView) getView().findViewById(R.id.presetName);
                if (tv != null) {
                    tv.setText(profileName);
                }
                ImageView v = (ImageView) getView().findViewById(R.id.revertButtonMain);
                if (v != null) {
                    v.setImageResource(R.drawable.revert_profile);
                    v.setVisibility(modified ? 0 : 4);
                }
            } catch (Exception e2) {
                e2.printStackTrace();
                this.mFObserver.onDsApiError();
            }
        }
    }

    public void cancelPendingEdition() {
        endEditingProfileName(true);
    }

    private void onDolbyClientUseClick(View view) {
        if (this.mDolbyClientConnected && this.mFObserver.useDsApiOnUiEvent()) {
            boolean bModified_Custom1 = false;
            boolean bModified_Custom2 = false;
            int cmf = DS1Application.getCustomModifyFlag(getActivity());
            if (1 == (cmf & 1)) {
                bModified_Custom1 = true;
            }
            if (2 == (cmf & 2)) {
                bModified_Custom2 = true;
            }
            try {
                int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
                if (selectedProfile + 1 == 5) {
                    bModified_Custom1 = false;
                } else if (selectedProfile + 1 == 6) {
                    bModified_Custom2 = false;
                }
                DS1Application.saveCustomNameModifiedStatus(getActivity(), bModified_Custom1, bModified_Custom2);
                int id = view.getId();
                if (R.id.revertButtonMain == id) {
                    this.mSpecificObserver.profileReset(selectedProfile);
                }
            } catch (Exception e) {
                e.printStackTrace();
                this.mFObserver.onDsApiError();
            }
        }
    }

    private void startEditingProfileName(TextView text, EditText edit, int position) {
        endEditingProfileName(true);
        if (position > 4 && text != null && edit != null) {
            edit.setFilters(new InputFilter[]{new InputFilter.LengthFilter(14)});
            edit.setTypeface(Assets.getFont(Assets.FontType.REGULAR));
            edit.setText(text.getText());
            text.setVisibility(4);
            edit.setVisibility(0);
            edit.setOnEditorActionListener(this);
            edit.setImeOptions(6);
            edit.setOnKeyListener(this);
            Tools.showVirtualKeyboard(getActivity());
            if (edit.isInTouchMode()) {
                edit.requestFocusFromTouch();
            } else {
                edit.requestFocus();
            }
            edit.setSelection(0, edit.getText().length());
            this.mCurrentlyEditedProfile = new ProfileEditInfo(position - 1, text, edit);
            this.mSpecificObserver.onProfileNameEditStarted();
        }
    }

    private void endEditingProfileName(boolean accept) {
        if (this.mCurrentlyEditedProfile != null) {
            if (accept) {
                boolean bModified_Custom1 = false;
                boolean bModified_Custom2 = false;
                int cmf = DS1Application.getCustomModifyFlag(getActivity());
                if (1 == (cmf & 1)) {
                    bModified_Custom1 = true;
                }
                if (2 == (cmf & 2)) {
                    bModified_Custom2 = true;
                }
                String newName = this.mCurrentlyEditedProfile.mEditText.getText().toString();
                if (!newName.isEmpty()) {
                    if (this.mCurrentlyEditedProfile.mPosition + 1 == 5) {
                        if (newName.equals(getActivity().getString(R.string.preset_1))) {
                            bModified_Custom1 = false;
                        } else {
                            bModified_Custom1 = true;
                        }
                    } else if (this.mCurrentlyEditedProfile.mPosition + 1 == 6) {
                        if (newName.equals(getActivity().getString(R.string.preset_2))) {
                            bModified_Custom2 = false;
                        } else {
                            bModified_Custom2 = true;
                        }
                    }
                    DS1Application.saveCustomNameModifiedStatus(getActivity(), bModified_Custom1, bModified_Custom2);
                    this.mCurrentlyEditedProfile.mTextView.setText(newName);
                    try {
                        this.mDsClient.setProfileName(this.mCurrentlyEditedProfile.mPosition, newName);
                    } catch (Exception e) {
                        e.printStackTrace();
                        this.mFObserver.onDsApiError();
                        return;
                    }
                }
            }
            Tools.hideVirtualKeyboard(getActivity());
            this.mCurrentlyEditedProfile.mEditText.setOnEditorActionListener(null);
            this.mCurrentlyEditedProfile.mEditText.setOnKeyListener(null);
            this.mCurrentlyEditedProfile.mEditText.setVisibility(8);
            this.mCurrentlyEditedProfile.mTextView.setVisibility(0);
            this.mCurrentlyEditedProfile = null;
        }
        this.mSpecificObserver.onProfileNameEditEnded();
        setResetProfileVisibility();
    }
}
