package com.dolby.ds1appUI;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.ImageView;
import com.dolby.ds1appCoreUI.DS1Application;
import com.dolby.ds1appCoreUI.Tag;
import java.util.ArrayList;

/* JADX INFO: loaded from: classes.dex */
public class EqualizerAdapter extends BaseAdapter implements View.OnTouchListener {
    private final LayoutInflater mInflater;
    private final int mLayout;
    private final IPresetListener mListener;
    private boolean mNewLayout;
    private final Drawable mSelectedBg;
    private int mSelectedPosition;
    private boolean mDobyOn = true;
    private final Runnable mNotifyDataSetChanged = new Runnable() { // from class: com.dolby.ds1appUI.EqualizerAdapter.1
        @Override // java.lang.Runnable
        public void run() {
            EqualizerAdapter.this.notifyDataSetChanged();
        }
    };
    private final ArrayList<EqualizerSetting> mSettings = new ArrayList<>();

    public interface IPresetListener {
        void onPresetChanged(int i);
    }

    public EqualizerAdapter(Context context, int layout, IPresetListener listener) {
        this.mSelectedPosition = -1;
        this.mNewLayout = false;
        this.mInflater = LayoutInflater.from(context);
        this.mListener = listener;
        this.mSelectedBg = context.getResources().getDrawable(R.drawable.eqlistsel);
        this.mLayout = layout;
        this.mSelectedPosition = 0;
        this.mNewLayout = context.getResources().getBoolean(R.bool.newLayout);
        this.mSettings.add(new EqualizerSetting(context.getString(R.string.open), R.drawable.eq1sel, R.drawable.eq1, R.drawable.eq1dis));
        this.mSettings.add(new EqualizerSetting(context.getString(R.string.rich), R.drawable.eq2sel, R.drawable.eq2, R.drawable.eq2dis));
        this.mSettings.add(new EqualizerSetting(context.getString(R.string.focused), R.drawable.eq3sel, R.drawable.eq3, R.drawable.eq3dis));
        if (this.mNewLayout) {
            this.mSettings.add(new EqualizerSetting(context.getString(R.string.custom), R.drawable.eq4sel, R.drawable.eq4, R.drawable.eq4dis));
        }
    }

    @Override // android.widget.Adapter
    public int getCount() {
        return this.mSettings.size();
    }

    @Override // android.widget.Adapter
    public EqualizerSetting getItem(int position) {
        return this.mSettings.get(position);
    }

    @Override // android.widget.Adapter
    public long getItemId(int position) {
        return position;
    }

    @Override // android.widget.Adapter
    public View getView(int position, View convertView, ViewGroup parent) {
        View row = convertView;
        if (convertView == null) {
            row = this.mInflater.inflate(this.mLayout, (ViewGroup) null);
            row.setOnTouchListener(this);
        }
        EqualizerSetting item = this.mSettings.get(position);
        boolean enabled = parent.isEnabled();
        boolean selected = position == this.mSelectedPosition && enabled;
        ImageView icon = (ImageView) row.findViewById(R.id.icon);
        icon.setImageResource(item.getIcon(selected, enabled));
        if (this.mNewLayout) {
            row.setBackgroundResource(selected ? R.drawable.eqlistsel : R.drawable.eqlistoff);
        } else {
            row.setBackground(selected ? this.mSelectedBg : null);
        }
        row.setTag(Integer.valueOf(position));
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

    public void setDolbyOnOff(boolean on) {
        this.mDobyOn = on;
    }

    @Override // android.widget.BaseAdapter
    public void notifyDataSetChanged() {
        Log.d(Tag.MAIN, "EqualizerAdapter.notifyDataSetChanged");
        super.notifyDataSetChanged();
    }

    public void scheduleNotifyDataSetChanged() {
        Log.d(Tag.MAIN, "EqualizerAdapter.scheduleNotifyDataSetChanged");
        DS1Application.HANDLER.removeCallbacks(this.mNotifyDataSetChanged);
        DS1Application.HANDLER.post(this.mNotifyDataSetChanged);
    }

    @Override // android.view.View.OnTouchListener
    public boolean onTouch(View v, MotionEvent e) {
        Integer nPos;
        if (!this.mDobyOn) {
            return false;
        }
        int action = e.getAction();
        if (action != 0 && 1 != action) {
            return false;
        }
        if (action == 0 && this.mListener != null && (nPos = (Integer) v.getTag()) != null) {
            this.mListener.onPresetChanged(nPos.intValue());
        }
        return true;
    }
}
