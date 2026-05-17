package com.dolby.ds1appUI;

import android.app.Activity;
import android.app.Fragment;
import android.content.Intent;
import android.dolby.DsClient;
import android.dolby.DsClientSettings;
import android.dolby.IDsClientEvents;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.AdapterView;
import android.widget.ListAdapter;
import com.dolby.ds1appCoreUI.DS1Application;
import com.dolby.ds1appCoreUI.Tag;
import com.dolby.ds1appCoreUI.Tools;

/* JADX INFO: loaded from: classes.dex */
public class FragProfilePresets extends Fragment implements View.OnClickListener, AdapterView.OnItemClickListener, AdapterView.OnItemLongClickListener, IDsClientEvents {
    private DsClient mDsClient;
    private IDsFragObserver mFObserver;
    private ViewGroup mNativeRootContainer;
    private ProfilesAdapter mProfilesAdapter;
    private IDsFragProfilePresetsObserver mSpecificObserver;
    private boolean mDolbyClientConnected = false;
    private boolean mMobileLayout = false;

    /* JADX WARN: Multi-variable type inference failed */
    @Override // android.app.Fragment
    public void onAttach(Activity activity) {
        super.onAttach(activity);
        try {
            this.mFObserver = (IDsFragObserver) activity;
            try {
                this.mSpecificObserver = (IDsFragProfilePresetsObserver) activity;
                this.mDsClient = this.mFObserver.getDsClient();
                this.mMobileLayout = getResources().getBoolean(R.bool.newLayout);
            } catch (ClassCastException e) {
                throw new ClassCastException(activity.toString() + " must implement IDsFragProfilePresetsObserver");
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
        View v = inflater.inflate(R.layout.fragprofilepresets, container, false);
        AdapterView<ListAdapter> lv = (AdapterView) v.findViewById(R.id.presetsListView);
        this.mProfilesAdapter = new ProfilesAdapter((MainActivity) getActivity(), R.layout.preset_list_item, this.mDsClient, this);
        lv.setAdapter(this.mProfilesAdapter);
        lv.setOnItemClickListener(this);
        lv.setOnItemLongClickListener(this);
        this.mNativeRootContainer = ViewTools.determineNativeViewContainer(getActivity());
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
            this.mSpecificObserver.profilePresetsAreAlive();
        }
    }

    @Override // android.app.Fragment
    public void onPause() {
        if (this.mProfilesAdapter != null) {
            this.mProfilesAdapter.endEditingProfileName(true);
        }
        super.onPause();
    }

    public void onClientConnected() {
        this.mDolbyClientConnected = true;
        if (this.mMobileLayout) {
            this.mSpecificObserver.profilePresetsAreAlive();
        }
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
        if (this.mProfilesAdapter != null) {
            this.mProfilesAdapter.scheduleNotifyDataSetChanged();
        }
    }

    public void onEqSettingsChanged(int profile, int preset) {
        try {
            DsClientSettings settings = this.mDsClient.getProfileSettings(profile);
            DsClientCache.INSTANCE.cacheProfileSettings(this.mDsClient, profile, settings);
            int selectedProfile = DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient);
            if (profile == selectedProfile) {
                this.mProfilesAdapter.scheduleNotifyDataSetChanged();
            }
        } catch (Exception e) {
            e.printStackTrace();
            this.mFObserver.onDsApiError();
        }
    }

    @Override // android.view.View.OnClickListener
    public void onClick(View view) {
        onDolbyClientUseClick(view);
    }

    @Override // android.widget.AdapterView.OnItemLongClickListener
    public boolean onItemLongClick(AdapterView<?> parent, View view, int position, long id) {
        if (parent.getId() == R.id.presetsListView) {
            try {
                if (DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient) != position - 1) {
                    onItemClick(parent, view, position, id);
                }
                this.mProfilesAdapter.startEditingProfileName(position);
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                this.mFObserver.onDsApiError();
                return true;
            }
        }
        return false;
    }

    @Override // android.widget.AdapterView.OnItemClickListener
    public void onItemClick(AdapterView<?> parent, View view, int position, long id) {
        if (position == 0) {
            startActivity(new Intent(MainActivity.ACTION_LAUNCH_DS1_INSTOREDEMO_APP));
            return;
        }
        if (this.mMobileLayout) {
            try {
                if (DsClientCache.INSTANCE.getSelectedProfile(this.mDsClient) == position - 1) {
                    this.mSpecificObserver.editProfile();
                    return;
                }
            } catch (Exception e) {
                e.printStackTrace();
                this.mFObserver.onDsApiError();
                return;
            }
        }
        this.mProfilesAdapter.endEditingProfileName(true);
        if (parent == getView().findViewById(R.id.presetsListView) && this.mFObserver.useDsApiOnUiEvent()) {
            this.mSpecificObserver.chooseProfile(position - 1);
        }
    }

    public void setSelection(int profile) {
        if (this.mProfilesAdapter != null) {
            this.mProfilesAdapter.setSelection(profile + 1);
        }
    }

    public int getSelection() {
        return this.mProfilesAdapter.getSelection() - 1;
    }

    public String getDefaultProfileName(int profile) {
        return this.mProfilesAdapter.getDefaultProfileName(profile + 1);
    }

    public String getItemName(int profile) {
        return this.mProfilesAdapter != null ? this.mProfilesAdapter.getItemName(profile + 1) : "";
    }

    public void setEnabled(boolean on) {
        if (isAdded()) {
            View theFragV = getView();
            if (!on && this.mProfilesAdapter != null) {
                this.mProfilesAdapter.endEditingProfileName(true);
            }
            View listView = theFragV.findViewById(R.id.presetsListView);
            if (listView != null) {
                listView.setEnabled(on);
            }
        }
    }

    public void scheduleNotifyDataSetChanged() {
        if (this.mProfilesAdapter != null) {
            this.mProfilesAdapter.scheduleNotifyDataSetChanged();
        }
    }

    public void onProfileNameEditStarted() {
        Log.d(Tag.MAIN, "Main.onProfileNameEditStarted()");
        if (Tools.isLandscapeScreenOrientation(getActivity()) && this.mNativeRootContainer != null) {
            ViewTreeObserver.OnPreDrawListener preDrawListener = new ViewTreeObserver.OnPreDrawListener() { // from class: com.dolby.ds1appUI.FragProfilePresets.1
                private int counter = 30;
                private final Runnable refreshLayout = new Runnable() { // from class: com.dolby.ds1appUI.FragProfilePresets.1.1
                    @Override // java.lang.Runnable
                    public void run() {
                        refreshLayout();
                    }
                };
                private final Runnable removePreDrawListener = new Runnable() { // from class: com.dolby.ds1appUI.FragProfilePresets.1.2
                    @Override // java.lang.Runnable
                    public void run() {
                        removePreDrawListener();
                    }
                };
                private boolean skipNext = false;

                @Override // android.view.ViewTreeObserver.OnPreDrawListener
                public boolean onPreDraw() {
                    StringBuilder sbAppend = new StringBuilder().append("Main.onProfileNameEditStarted.onPreDraw() ");
                    int i = this.counter;
                    this.counter = i - 1;
                    Log.d(Tag.MAIN, sbAppend.append(i).toString());
                    if (!this.skipNext) {
                        DS1Application.HANDLER.removeCallbacks(this.refreshLayout);
                        DS1Application.HANDLER.postDelayed(this.refreshLayout, 100L);
                    } else {
                        this.skipNext = false;
                    }
                    if (this.counter <= 0) {
                        removePreDrawListener();
                        return true;
                    }
                    return true;
                }

                /* JADX INFO: Access modifiers changed from: private */
                public void refreshLayout() {
                    Log.d(Tag.MAIN, "Main.onProfileNameEditStarted.refreshLayout()");
                    if (FragProfilePresets.this.mNativeRootContainer != null) {
                        this.skipNext = true;
                        FragProfilePresets.this.mNativeRootContainer.requestLayout();
                        FragProfilePresets.this.mNativeRootContainer.invalidate();
                        DS1Application.HANDLER.removeCallbacks(this.refreshLayout);
                        DS1Application.HANDLER.removeCallbacks(this.removePreDrawListener);
                        DS1Application.HANDLER.postDelayed(this.removePreDrawListener, 2000L);
                    }
                }

                /* JADX INFO: Access modifiers changed from: private */
                public void removePreDrawListener() {
                    Log.d(Tag.MAIN, "Main.onProfileNameEditStarted.removePreDrawListener()");
                    DS1Application.HANDLER.removeCallbacks(this.refreshLayout);
                    DS1Application.HANDLER.removeCallbacks(this.removePreDrawListener);
                    FragProfilePresets.this.mNativeRootContainer.getViewTreeObserver().removeOnPreDrawListener(this);
                }
            };
            this.mNativeRootContainer.getViewTreeObserver().addOnPreDrawListener(preDrawListener);
        }
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
                if (R.id.revertButton == id) {
                    this.mSpecificObserver.profileReset(selectedProfile);
                }
            } catch (Exception e) {
                e.printStackTrace();
                this.mFObserver.onDsApiError();
            }
        }
    }
}
