package com.solarized.firedown.utils;

import android.os.Bundle;
import android.os.Parcelable;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;

/**
 * Static helpers for reading fragment arguments safely across
 * process-death restore.
 *
 * <p>Android restores fragment argument bundles with the system
 * classloader, not the app's. {@code Bundle.getParcelable} then
 * returns null silently for app-defined Parcelables — the bytes are
 * intact, the loader just can't resolve the class. These helpers set
 * the classloader before reading so the parcelable comes back as
 * expected, removing the need for every caller to remember.</p>
 *
 * <p>A null return is the dismiss signal — args were never set, or
 * the parcelable genuinely couldn't be resolved. Callers should
 * dismiss / pop instead of crashing.</p>
 */
public final class FragmentArgs {

    private FragmentArgs() {}

    @Nullable
    public static <T extends Parcelable> T parcelable(@NonNull Fragment fragment,
                                                      @NonNull String key,
                                                      @NonNull Class<T> type) {
        Bundle args = fragment.getArguments();
        if (args == null) return null;
        args.setClassLoader(type.getClassLoader());
        return args.getParcelable(key);
    }
}
