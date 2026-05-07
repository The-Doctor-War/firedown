package com.solarized.firedown.settings.ui;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

import androidx.annotation.NonNull;
import androidx.preference.CheckBoxPreference;
import androidx.preference.PreferenceViewHolder;

public class RemovableCheckBoxPreference extends CheckBoxPreference {

    private View.OnLongClickListener mLongClickListener;

    public RemovableCheckBoxPreference(Context context, AttributeSet attrs, int defStyle) {
        super(context, attrs, defStyle);
    }

    public RemovableCheckBoxPreference(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public RemovableCheckBoxPreference(Context context) {
        super(context);
    }

    public void setOnLongClickListener(View.OnLongClickListener listener) {
        mLongClickListener = listener;
    }

    @Override
    public void onBindViewHolder(@NonNull PreferenceViewHolder holder) {
        super.onBindViewHolder(holder);
        holder.itemView.setOnLongClickListener(mLongClickListener);
    }
}
