package com.solarized.firedown.phone.dialogs;

import android.app.Dialog;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.RadioButton;
import android.widget.RadioGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.lifecycle.ViewModelProvider;

import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.solarized.firedown.R;
import com.solarized.firedown.data.models.WebHistoryViewModel;

public class DeleteHistoryDialogFragment extends BaseDialogFragment {

    private int mSelectedPosition = 0;

    private WebHistoryViewModel mWebHistoryViewModel;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        mWebHistoryViewModel = new ViewModelProvider(this).get(WebHistoryViewModel.class);

    }


    @NonNull
    @Override
    public Dialog onCreateDialog(@Nullable Bundle savedInstanceState) {
        int themeResId = mIsIncognito
                ? R.style.Theme_FireDown_VaultDialogTheme
                : getTheme();
        final View view = LayoutInflater.from(requireContext())
                .inflate(R.layout.dialog_delete_history, null);
        final RadioGroup group = view.findViewById(R.id.delete_history_options);
        final CharSequence[] items = getResources().getTextArray(R.array.delete_history);
        for (int i = 0; i < items.length; i++) {
            final RadioButton button = new RadioButton(requireContext());
            button.setId(View.generateViewId());
            button.setText(items[i]);
            button.setChecked(i == mSelectedPosition);
            group.addView(button, new RadioGroup.LayoutParams(
                    RadioGroup.LayoutParams.MATCH_PARENT,
                    RadioGroup.LayoutParams.WRAP_CONTENT));
        }
        group.setOnCheckedChangeListener((g, checkedId) -> {
            for (int i = 0; i < g.getChildCount(); i++) {
                if (g.getChildAt(i).getId() == checkedId) {
                    mSelectedPosition = i;
                    return;
                }
            }
        });
        return new MaterialAlertDialogBuilder(requireContext(), themeResId)
                .setTitle(R.string.delete_history_prompt_title)
                .setView(view)
                .setPositiveButton(R.string.delete, (dialog, which) ->
                        mWebHistoryViewModel.deleteSelection(mSelectedPosition))
                .setNegativeButton(R.string.cancel, (dialog, which) -> dismiss())
                .create();
    }


}
