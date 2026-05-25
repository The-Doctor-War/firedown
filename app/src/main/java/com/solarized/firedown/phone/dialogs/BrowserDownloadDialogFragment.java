package com.solarized.firedown.phone.dialogs;


import android.app.Dialog;
import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.lifecycle.ViewModelProvider;

import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.BrowserDownloadEntity;
import com.solarized.firedown.data.entity.OptionEntity;
import com.solarized.firedown.data.models.BrowserDialogViewModel;
import com.solarized.firedown.Keys;
import com.solarized.firedown.data.models.GeckoStateViewModel;
import com.solarized.firedown.geckoview.GeckoState;
import com.solarized.firedown.manager.DownloadRequest;
import com.solarized.firedown.utils.Utils;

public class BrowserDownloadDialogFragment extends BaseDialogFragment {

    private BrowserDownloadEntity mEntity;

    private BrowserDialogViewModel mBrowserDialogViewModel;

    private GeckoState mGeckoState;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        mBrowserDialogViewModel = new ViewModelProvider(mActivity).get(BrowserDialogViewModel.class);
        GeckoStateViewModel geckoStateViewModel = new ViewModelProvider(mActivity).get(GeckoStateViewModel.class);

        Bundle bundle = getArguments();
        if (bundle == null) return;

        int sessionId = bundle.getInt(Keys.ITEM_ID);
        mGeckoState = geckoStateViewModel.getGeckoState(sessionId);
        // mGeckoState is null when the session has been collected (process
        // death wipes session state). onCreateDialog dismisses in that case.
        if (mGeckoState == null || mGeckoState.getWebResponse() == null) return;
        mEntity = new BrowserDownloadEntity(mGeckoState);
    }

    @NonNull
    @Override
    public Dialog onCreateDialog(@Nullable Bundle savedInstanceState) {

        if (mEntity == null) {
            Dialog dialog = new Dialog(requireContext());
            dialog.setOnShowListener(d -> dismissAllowingStateLoss());
            return dialog;
        }

        int themeResId = mIsIncognito
                ? R.style.Theme_FireDown_VaultDialogTheme
                : getTheme(); // or just use the default

        long length = mEntity.getFileLength();
        String fileName = mEntity.getFileName();
        String message = length <= 0
                ? fileName
                : String.format("%s (%s)", fileName, Utils.getFileSize(length));

        return new MaterialAlertDialogBuilder(requireContext(), themeResId)
                .setTitle(getString(R.string.download_file))
                .setMessage(message)
                .setPositiveButton(getString(R.string.download), (dialog, which) -> {
                    DownloadRequest request = DownloadRequest.from(mEntity);

                    OptionEntity optionEntity = new OptionEntity();
                    optionEntity.setId(R.id.action_download);
                    optionEntity.setDownloadRequest(request);
                    mBrowserDialogViewModel.onOptionSelected(optionEntity);

                    dismiss();
                })
                .setNegativeButton(getString(R.string.cancel), (dialog, which) -> {
                    if (mGeckoState != null) {
                        mGeckoState.setWebResponse(null);
                    }
                    dismiss();
                })
                .create();
    }
}