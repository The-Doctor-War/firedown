package com.solarized.firedown.settings;

import android.os.Bundle;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.preference.Preference;
import androidx.preference.PreferenceCategory;
import androidx.preference.SwitchPreferenceCompat;

import com.solarized.firedown.Preferences;
import com.solarized.firedown.R;
import com.solarized.firedown.data.repository.WasmAllowlistRepository;

import java.util.List;

import dagger.hilt.android.AndroidEntryPoint;

/**
 * Settings sub-screen for WebAssembly. Hosts:
 *
 * <ul>
 *   <li>The global {@code javascript.options.wasm} toggle (the same one
 *       that used to live directly on the main Settings list).</li>
 *   <li>The per-site allowlist — every host the user has approved via
 *       the "Enable for X?" snackbar. Tap a host to open a remove
 *       confirmation; the "Clear all" entry wipes the entire list.</li>
 * </ul>
 *
 * <p>SettingsFragment routes here via the
 * {@code action_settings_to_wasm} navigation action.</p>
 */
@AndroidEntryPoint
public class WasmFragment extends BasePreferenceFragment {

    private static final String KEY_LIST_CATEGORY =
            "com.solarized.firedown.preferences.browser.wasm.allowlist.category";
    private static final String KEY_EMPTY =
            "com.solarized.firedown.preferences.browser.wasm.allowlist.empty";
    private static final String KEY_CLEAR =
            "com.solarized.firedown.preferences.browser.wasm.allowlist.clear";
    private static final String KEY_HOST_PREFIX =
            "com.solarized.firedown.preferences.browser.wasm.allowlist.host.";

    private PreferenceCategory mListCategory;
    private Preference mEmptyPreference;
    private Preference mClearPreference;
    private WasmAllowlistRepository mRepository;

    @Override
    public void onCreatePreferences(Bundle savedInstanceState, String rootKey) {
        super.onCreatePreferences(savedInstanceState, rootKey);
        setPreferencesFromResource(R.xml.settings_wasm, rootKey);

        mRepository = mGeckoRuntimeHelper.getWasmAllowlistRepository();

        // Apply the toggle to Gecko ourselves. SettingsFragment's
        // SharedPreferenceChangeListener is unregistered while this
        // fragment is in the foreground, so the global pref wouldn't
        // otherwise propagate to the runtime.
        SwitchPreferenceCompat toggle = findPreference(Preferences.SETTINGS_ENABLE_WEBASSEMBLY);
        if (toggle != null) {
            toggle.setOnPreferenceChangeListener((p, value) -> {
                boolean enabled = Boolean.TRUE.equals(value);
                mGeckoRuntimeHelper.setWebAssembly(enabled);
                return true;
            });
        }

        mListCategory = findPreference(KEY_LIST_CATEGORY);
        mEmptyPreference = findPreference(KEY_EMPTY);
        mClearPreference = findPreference(KEY_CLEAR);

        if (mClearPreference != null) {
            mClearPreference.setOnPreferenceClickListener(p -> {
                confirmClearAll();
                return true;
            });
        }

        mRepository.getHostsLive().observe(this, this::renderHosts);
        tintIcons();
    }

    private void renderHosts(@NonNull List<String> hosts) {
        if (mListCategory == null) return;

        // Sweep out previously-rendered host preferences (keep the empty
        // placeholder + the "Clear all" row managed via setVisible).
        for (int i = mListCategory.getPreferenceCount() - 1; i >= 0; i--) {
            Preference p = mListCategory.getPreference(i);
            if (p.getKey() != null && p.getKey().startsWith(KEY_HOST_PREFIX)) {
                mListCategory.removePreference(p);
            }
        }

        boolean empty = hosts.isEmpty();
        if (mEmptyPreference != null) mEmptyPreference.setVisible(empty);
        if (mClearPreference != null) mClearPreference.setVisible(!empty);

        // Insert host preferences AFTER the empty placeholder, BEFORE
        // the "Clear all" entry. addPreference appends to the end of the
        // category; reordering by setOrder keeps the structure clean.
        int order = 100;
        for (String host : hosts) {
            Preference p = new Preference(requireContext());
            p.setKey(KEY_HOST_PREFIX + host);
            p.setTitle(host);
            p.setIcon(R.drawable.ic_globe_24);
            p.setOrder(order++);
            p.setOnPreferenceClickListener(pref -> {
                confirmRemove(host);
                return true;
            });
            mListCategory.addPreference(p);
        }

        // Push the clear-all action below the host list.
        if (mClearPreference != null) mClearPreference.setOrder(order + 1);

        // Re-tint icons for the freshly-added preferences.
        tintIcons();
    }

    private void confirmRemove(@NonNull String host) {
        new AlertDialog.Builder(requireContext())
                .setTitle(R.string.settings_wasm_allowlist_remove_title)
                .setMessage(getString(R.string.settings_wasm_allowlist_remove_message, host))
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.settings_wasm_allowlist_remove_confirm,
                        (d, w) -> mRepository.deleteByHost(host))
                .show();
    }

    private void confirmClearAll() {
        new AlertDialog.Builder(requireContext())
                .setTitle(R.string.settings_wasm_allowlist_clear)
                .setMessage(R.string.settings_wasm_allowlist_clear_message)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.settings_wasm_allowlist_clear_confirm,
                        (d, w) -> mRepository.deleteAll())
                .show();
    }
}
