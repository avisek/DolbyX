package com.dolby.ds1appUI;

import android.app.DialogFragment;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

/* JADX INFO: loaded from: classes.dex */
public class TooltipDialog extends DialogFragment {
    public static TooltipDialog newInstance(int title, int text) {
        TooltipDialog f = new TooltipDialog();
        Bundle args = new Bundle();
        args.putInt("Title", title);
        args.putInt("Text", text);
        f.setArguments(args);
        return f;
    }

    @Override // android.app.DialogFragment, android.app.Fragment
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setStyle(2, 0);
    }

    @Override // android.app.Fragment
    public View onCreateView(LayoutInflater inflater, ViewGroup container, Bundle savedInstanceState) {
        View v = inflater.inflate(R.layout.tooltip1, container, false);
        View tv = v.findViewById(R.id.text);
        ((TextView) tv).setText(getArguments().getInt("Text"));
        View tv2 = v.findViewById(R.id.title);
        ((TextView) tv2).setText(getArguments().getInt("Title"));
        getDialog().setCanceledOnTouchOutside(true);
        return v;
    }
}
