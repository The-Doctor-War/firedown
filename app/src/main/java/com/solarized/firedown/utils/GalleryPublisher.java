package com.solarized.firedown.utils;

import android.content.Context;
import android.media.MediaScannerConnection;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * Surfaces finished downloads to the system gallery via
 * {@link MediaScannerConnection#scanFile} so stock gallery apps,
 * Google Photos, etc. pick them up. Image / video / audio only —
 * scanning a PDF or APK does nothing useful and risks misclassification.
 *
 * <p>The caller is responsible for the privacy gate. Vault / incognito
 * files must not be passed in: once scanned, they're indexed by every
 * gallery app on the device.</p>
 */
public final class GalleryPublisher {

    private GalleryPublisher() {}

    public static void publish(@NonNull Context context,
                               @Nullable String filePath,
                               @Nullable String mimeType) {
        if (TextUtils.isEmpty(filePath)) return;
        if (!isMedia(mimeType)) return;
        MediaScannerConnection.scanFile(
                context.getApplicationContext(),
                new String[]{filePath},
                new String[]{mimeType},
                null);
    }

    private static boolean isMedia(@Nullable String mimeType) {
        if (TextUtils.isEmpty(mimeType)) return false;
        return FileUriHelper.isImage(mimeType)
                || FileUriHelper.isVideo(mimeType)
                || FileUriHelper.isAudio(mimeType);
    }
}
