package com.dolby.ds1appUI;

import android.content.res.Resources;
import android.dolby.DsClient;
import android.text.Editable;
import android.text.InputFilter;
import android.text.TextWatcher;
import android.util.Log;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.TextView;
import com.dolby.ds1appCoreUI.DS1Application;
import com.dolby.ds1appCoreUI.Tag;
import com.dolby.ds1appCoreUI.Tools;
import com.dolby.ds1appUI.Assets;

/* JADX INFO: loaded from: classes.dex */
public class ProfilesAdapter extends BaseAdapter implements View.OnKeyListener, TextView.OnEditorActionListener, TextWatcher {
    private final MainActivity mActivity;
    private String mCurrentlyEditName;
    private final DsClient mDsClient;
    private final int mLayout;
    private boolean mNewLayout;
    private View.OnClickListener mOnClickListener;
    private final Profile[] mProfiles;
    private int mSelectedPosition = -1;
    private int mCurrentlyEditedProfile = -1;
    private boolean mEditable = false;
    private final Runnable mNotifyDataSetChanged = new Runnable() { // from class: com.dolby.ds1appUI.ProfilesAdapter.1
        @Override // java.lang.Runnable
        public void run() {
            ProfilesAdapter.this.notifyDataSetChanged();
        }
    };
    private final String[] mDefaultProfileNames = new String[7];

    public ProfilesAdapter(MainActivity context, int layout, DsClient dsClient, View.OnClickListener listener) {
        this.mNewLayout = false;
        this.mActivity = context;
        this.mLayout = layout;
        this.mDsClient = dsClient;
        this.mOnClickListener = listener;
        this.mNewLayout = context.getResources().getBoolean(R.bool.newLayout);
        this.mDefaultProfileNames[0] = context.getString(R.string.instore_menu_text);
        this.mDefaultProfileNames[1] = context.getString(R.string.movie);
        this.mDefaultProfileNames[2] = context.getString(R.string.music);
        this.mDefaultProfileNames[3] = context.getString(R.string.game);
        this.mDefaultProfileNames[4] = context.getString(R.string.voice);
        this.mDefaultProfileNames[5] = context.getString(R.string.preset_1);
        this.mDefaultProfileNames[6] = context.getString(R.string.preset_2);
        this.mProfiles = new Profile[7];
        this.mProfiles[0] = new Profile(R.drawable.profileblank, R.drawable.profileblank, R.drawable.profileblank);
        this.mProfiles[1] = new Profile(R.drawable.movieon, R.drawable.movieoff, R.drawable.moviedis);
        this.mProfiles[2] = new Profile(R.drawable.musicon, R.drawable.musicoff, R.drawable.musicdis);
        this.mProfiles[3] = new Profile(R.drawable.gameon, R.drawable.gameoff, R.drawable.gamedis);
        this.mProfiles[4] = new Profile(R.drawable.voiceon, R.drawable.voiceoff, R.drawable.voicedis);
        this.mProfiles[5] = new Profile(R.drawable.preset1on, R.drawable.preset1off, R.drawable.preset1dis);
        this.mProfiles[6] = new Profile(R.drawable.preset2on, R.drawable.preset2off, R.drawable.preset2dis);
    }

    @Override // android.widget.Adapter
    public int getCount() {
        return this.mProfiles.length;
    }

    @Override // android.widget.Adapter
    public Profile getItem(int position) {
        return this.mProfiles[position];
    }

    @Override // android.widget.Adapter
    public long getItemId(int position) {
        return position;
    }

    public String getItemName(int position) {
        if (position <= 4) {
            return this.mDefaultProfileNames[position];
        }
        String name = null;
        if (this.mActivity.isDolbyClientConnected()) {
            try {
                name = getProfileName(position - 1);
            } catch (Exception e) {
                e.printStackTrace();
            }
        }
        if (name != null) {
            boolean bModified_Custom1 = false;
            boolean bModified_Custom2 = false;
            int cmf = DS1Application.getCustomModifyFlag(this.mActivity);
            if (1 == (cmf & 1)) {
                bModified_Custom1 = true;
            }
            if (2 == (cmf & 2)) {
                bModified_Custom2 = true;
            }
            Log.d(Tag.MAIN, "[ProfilesAdapter.java] name = " + name + ", bModified_Custom1 = " + bModified_Custom1 + ", bModified_Custom2 = " + bModified_Custom2);
            if (!bModified_Custom1 && position == 5) {
                name = this.mDefaultProfileNames[position];
            } else if (!bModified_Custom2 && position == 6) {
                name = this.mDefaultProfileNames[position];
            }
        }
        return name == null ? this.mDefaultProfileNames[position] : name;
    }

    public String getDefaultProfileName(int position) {
        return this.mDefaultProfileNames[position];
    }

    @Override // android.widget.Adapter
    public View getView(int position, View convertView, ViewGroup parent) {
        String itemName;
        boolean enabled;
        int i;
        boolean dsConnected = this.mActivity.isDolbyClientConnected();
        View row = convertView;
        if (row == null) {
            if (position == 0) {
                row = LayoutInflater.from(parent.getContext()).inflate(R.layout.preset_list_item0, (ViewGroup) null);
            } else {
                row = LayoutInflater.from(parent.getContext()).inflate(this.mLayout, (ViewGroup) null);
            }
        } else {
            int tagIndex = Integer.parseInt(row.getTag().toString());
            if (position != tagIndex) {
                if (position == 0) {
                    row = LayoutInflater.from(parent.getContext()).inflate(R.layout.preset_list_item0, (ViewGroup) null);
                } else {
                    row = LayoutInflater.from(parent.getContext()).inflate(this.mLayout, (ViewGroup) null);
                }
            }
        }
        Profile item = this.mProfiles[position];
        boolean profileModified = false;
        boolean profileSettingsModified = false;
        if (position > 0) {
            try {
                profileSettingsModified = this.mDsClient.isProfileModified(position - 1);
            } catch (Exception e1) {
                e1.printStackTrace();
            }
        }
        boolean bModified_Custom1 = false;
        boolean bModified_Custom2 = false;
        int cmf = DS1Application.getCustomModifyFlag(this.mActivity);
        if (1 == (cmf & 1)) {
            bModified_Custom1 = true;
        }
        if (2 == (cmf & 2)) {
            bModified_Custom2 = true;
        }
        if (profileSettingsModified) {
            profileModified = true;
        } else if (position == 5 && bModified_Custom1) {
            profileModified = true;
        } else if (position == 6 && bModified_Custom2) {
            profileModified = true;
        }
        boolean engineEnabled = parent.isEnabled();
        if (position <= 4) {
            itemName = this.mDefaultProfileNames[position];
            enabled = true;
        } else {
            itemName = null;
            if (dsConnected) {
                itemName = getItemName(position);
                Log.d(Tag.MAIN, "ProfilesAdapter.getView(), itemName = " + itemName);
            }
            enabled = true;
            if (itemName == null) {
                itemName = this.mDefaultProfileNames[position];
            }
        }
        boolean enabled2 = enabled && engineEnabled;
        boolean selected = position == this.mSelectedPosition && engineEnabled;
        TextView nameTextView = (TextView) row.findViewById(R.id.name);
        ImageView icon = (ImageView) row.findViewById(R.id.icon);
        ImageView revertButton = (ImageView) row.findViewById(R.id.revertButton);
        if (nameTextView != null) {
            Resources resources = parent.getResources();
            if (enabled2) {
                i = R.color.white;
            } else {
                i = selected ? R.color.disabledblue_selected : R.color.disabledblue;
            }
            nameTextView.setTextColor(resources.getColor(i));
            if (convertView == null) {
                if (this.mNewLayout) {
                    nameTextView.setTypeface(Assets.getFont(Assets.FontType.LIGHT));
                } else {
                    nameTextView.setTypeface(Assets.getFont(Assets.FontType.REGULAR));
                }
            }
            if (this.mNewLayout || Tools.isLandscapeScreenOrientation(this.mActivity) || position == 0) {
                nameTextView.setText(itemName);
            } else {
                nameTextView.setText("");
            }
        }
        icon.setImageResource(item.getIcon(selected, enabled2));
        if (revertButton != null) {
            if (selected) {
                int vis = 4;
                if (dsConnected && profileModified) {
                    vis = 0;
                }
                revertButton.setVisibility(vis);
                revertButton.setImageResource(R.drawable.revert_profile);
            } else {
                revertButton.setVisibility(4);
            }
            revertButton.setOnClickListener(this.mOnClickListener);
        }
        row.setBackgroundResource(selected ? R.drawable.highlight : 0);
        EditText nameEdit = (EditText) row.findViewById(R.id.nameEdit);
        if (nameEdit != null) {
            this.mEditable = true;
            try {
                nameEdit.removeTextChangedListener(this);
            } catch (Exception e) {
            }
            if (position > 0 && this.mCurrentlyEditedProfile == position - 1) {
                nameEdit.setFilters(new InputFilter[]{new InputFilter.LengthFilter(14)});
                nameEdit.setTypeface(Assets.getFont(Assets.FontType.REGULAR));
                nameEdit.setText(this.mCurrentlyEditName);
                nameEdit.setVisibility(0);
                nameEdit.setSelection(0, nameEdit.getText().length());
                nameEdit.requestFocus();
                nameEdit.setOnEditorActionListener(this);
                nameEdit.setOnKeyListener(this);
                nameEdit.addTextChangedListener(this);
            } else {
                nameEdit.setOnEditorActionListener(null);
                nameEdit.setOnKeyListener(null);
                nameEdit.setVisibility(8);
            }
        }
        row.setTag(String.valueOf(position));
        return row;
    }

    public int getSelection() {
        return this.mSelectedPosition;
    }

    public void setSelection(int position) {
        if (this.mSelectedPosition != position) {
            this.mSelectedPosition = position;
            scheduleNotifyDataSetChanged();
        }
    }

    public int getCurrentlyEditedProfile() {
        return this.mCurrentlyEditedProfile;
    }

    public void startEditingProfileName(int position) {
        DsClient dsClient;
        Log.d(Tag.MAIN, "ProfilesAdapter.startEditingProfileName " + position);
        if (this.mEditable && position != 0 && (dsClient = this.mDsClient) != null && this.mActivity.isDolbyClientConnected()) {
            endEditingProfileName(true);
            if (position > 4) {
                try {
                    dsClient.isProfileModified(position - 1);
                    String name = getItemName(position);
                    this.mCurrentlyEditedProfile = position - 1;
                    this.mCurrentlyEditName = name;
                    Tools.showVirtualKeyboard(this.mActivity);
                    scheduleNotifyDataSetChanged();
                    this.mActivity.onProfileNameEditStarted();
                } catch (Exception e) {
                    e.printStackTrace();
                }
            }
        }
    }

    private String getProfileName(int position) {
        if (!this.mActivity.isDolbyClientConnected()) {
            return null;
        }
        try {
            return this.mDsClient.getProfileNames()[position];
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }

    public void endEditingProfileName(boolean accept) {
        Log.d(Tag.MAIN, "endEditingProfileName " + accept);
        if (this.mCurrentlyEditedProfile != -1) {
            boolean bModified_Custom1 = false;
            boolean bModified_Custom2 = false;
            int cmf = DS1Application.getCustomModifyFlag(this.mActivity);
            if (1 == (cmf & 1)) {
                bModified_Custom1 = true;
            }
            if (2 == (cmf & 2)) {
                bModified_Custom2 = true;
            }
            if (accept) {
                if (this.mCurrentlyEditName == null) {
                    this.mCurrentlyEditName = "";
                } else {
                    this.mCurrentlyEditName = this.mCurrentlyEditName.trim();
                }
                if (!this.mCurrentlyEditName.isEmpty()) {
                    if (!this.mCurrentlyEditName.equals(this.mDefaultProfileNames[this.mCurrentlyEditedProfile + 1])) {
                        if (this.mCurrentlyEditedProfile + 1 == 5) {
                            bModified_Custom1 = true;
                        } else if (this.mCurrentlyEditedProfile + 1 == 6) {
                            bModified_Custom2 = true;
                        }
                    } else if (this.mCurrentlyEditedProfile + 1 == 5) {
                        bModified_Custom1 = false;
                    } else if (this.mCurrentlyEditedProfile + 1 == 6) {
                        bModified_Custom2 = false;
                    }
                    try {
                        this.mDsClient.setProfileName(this.mCurrentlyEditedProfile, this.mCurrentlyEditName);
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                }
                this.mCurrentlyEditName = null;
            }
            this.mCurrentlyEditedProfile = -1;
            scheduleNotifyDataSetChanged();
            Tools.hideVirtualKeyboard(this.mActivity);
            this.mActivity.onProfileNameEditEnded();
            saveCustomNameModifiedStatus(bModified_Custom1, bModified_Custom2);
        }
    }

    public void saveCustomNameModifiedStatus(boolean bModified_Custom1, boolean bModified_Custom2) {
        DS1Application.saveCustomNameModifiedStatus(this.mActivity, bModified_Custom1, bModified_Custom2);
    }

    @Override // android.view.View.OnKeyListener
    public boolean onKey(View view, int keyCode, KeyEvent event) {
        if (view.getId() != R.id.nameEdit || event.getAction() != 0 || event.getKeyCode() != 4) {
            return false;
        }
        endEditingProfileName(false);
        return true;
    }

    @Override // android.widget.TextView.OnEditorActionListener
    public boolean onEditorAction(TextView view, int actionId, KeyEvent event) {
        if (view.getId() != R.id.nameEdit || ((actionId != 6 && actionId != 5 && actionId != 7) || (event != null && (event.getAction() != 0 || event.getKeyCode() != 66)))) {
            return false;
        }
        endEditingProfileName(true);
        return true;
    }

    @Override // android.text.TextWatcher
    public void afterTextChanged(Editable s) {
    }

    @Override // android.text.TextWatcher
    public void beforeTextChanged(CharSequence s, int start, int count, int after) {
    }

    @Override // android.text.TextWatcher
    public void onTextChanged(CharSequence s, int start, int before, int count) {
        this.mCurrentlyEditName = s.toString();
    }

    @Override // android.widget.BaseAdapter
    public void notifyDataSetChanged() {
        Log.d(Tag.MAIN, "ProfilesAdapter.notifyDataSetChanged");
        super.notifyDataSetChanged();
    }

    public void scheduleNotifyDataSetChanged() {
        Log.d(Tag.MAIN, "ProfilesAdapter.scheduleNotifyDataSetChanged");
        DS1Application.HANDLER.removeCallbacks(this.mNotifyDataSetChanged);
        DS1Application.HANDLER.post(this.mNotifyDataSetChanged);
    }
}
