package com.solarized.firedown.phone.dialogs;

import android.app.Dialog;
import android.os.Bundle;

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
        return new MaterialAlertDialogBuilder(requireContext(), themeResId)
                .setTitle(R.string.delete_history_prompt_title)
                .setMessage(R.string.delete_history_prompt_message)
                .setSingleChoiceItems(R.array.delete_history, mSelectedPosition,
                        (dialog, which) -> mSelectedPosition = which)
                .setPositiveButton(R.string.delete, (dialog, which) ->
                        mWebHistoryViewModel.deleteSelection(mSelectedPosition))
                .setNegativeButton(R.string.cancel, (dialog, which) -> dismiss())
                .create();
    }


}
