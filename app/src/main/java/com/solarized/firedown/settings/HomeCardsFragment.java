package com.solarized.firedown.settings;

import android.os.Bundle;

import androidx.annotation.Nullable;

import com.solarized.firedown.R;

/**
 * Settings sub-screen behind 'Home cards' on the general settings list.
 * Hosts two {@link androidx.preference.ListPreference} entries that let
 * the user pick which tonal container fronts the Downloads + Safe
 * Folder chips on the home page. Re-tinting happens lazily — the
 * choice is persisted, and {@code HomeFragment.applyHomeCardPalettes}
 * picks it up the next time the home view is created.
 */
public class HomeCardsFragment extends BasePreferenceFragment {

    @Override
    public void onCreatePreferences(@Nullable Bundle savedInstanceState, @Nullable String rootKey) {
        super.onCreatePreferences(savedInstanceState, rootKey);
        setPreferencesFromResource(R.xml.settings_home_cards, rootKey);
        tintIcons();
    }
}
