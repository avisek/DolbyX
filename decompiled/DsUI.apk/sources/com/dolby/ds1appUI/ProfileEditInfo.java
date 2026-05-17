package com.dolby.ds1appUI;

import android.widget.EditText;
import android.widget.TextView;

/* JADX INFO: loaded from: classes.dex */
public class ProfileEditInfo {
    public EditText mEditText;
    public int mPosition;
    public TextView mTextView;

    public ProfileEditInfo(int position, TextView textView, EditText editText) {
        this.mPosition = position;
        this.mTextView = textView;
        this.mEditText = editText;
    }
}
