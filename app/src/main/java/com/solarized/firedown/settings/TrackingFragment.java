package com.solarized.firedown.settings;

import android.os.Bundle;
import android.text.InputType;

import androidx.annotation.NonNull;
import androidx.preference.EditTextPreference;
import androidx.preference.Preference;
import com.solarized.firedown.Preferences;
import com.solarized.firedown.R;
import com.solarized.firedown.settings.ui.RadioButtonPreference;
import org.mozilla.geckoview.ContentBlocking;


public class TrackingFragment extends BasePreferenceFragment implements Preference.OnPreferenceClickListener {

    private static final String TAG = TrackingFragment.class.getName();

    private RadioButtonPreference mDefaultPreference;

    private RadioButtonPreference mStrictPreference;

    private RadioButtonPreference mCustomPreference;

    private EditTextPreference mStripListPreference;


    @Override
    public void onCreatePreferences(Bundle savedInstanceState, String rootKey) {
        super.onCreatePreferences(savedInstanceState, rootKey);

        setPreferencesFromResource(R.xml.settings_tracking, rootKey);

        mDefaultPreference = getPreferenceScreen().findPreference(Preferences.SETTINGS_ANTI_TRACKING_DEFAULT);

        mStrictPreference = getPreferenceScreen().findPreference(Preferences.SETTINGS_ANTI_TRACKING_STRICT);

        mCustomPreference = getPreferenceScreen().findPreference(Preferences.SETTINGS_ANTI_TRACKING_CUSTOM);

        mStripListPreference = getPreferenceScreen().findPreference(Preferences.SETTINGS_ANTI_TRACKING_STRIP_LIST);

        mDefaultPreference.addToRadioGroup(mStrictPreference);
        mDefaultPreference.addToRadioGroup(mCustomPreference);
        mStrictPreference.addToRadioGroup(mDefaultPreference);
        mStrictPreference.addToRadioGroup(mCustomPreference);
        mCustomPreference.addToRadioGroup(mDefaultPreference);
        mCustomPreference.addToRadioGroup(mStrictPreference);

        if(mDefaultPreference != null)
            mDefaultPreference.setOnPreferenceClickListener(this);

        if(mStrictPreference != null)
            mStrictPreference.setOnPreferenceClickListener(this);

        if(mCustomPreference != null)
            mCustomPreference.setOnPreferenceClickListener(this);

        if(mStripListPreference != null) {
            mStripListPreference.setOnBindEditTextListener(editText -> {
                editText.setInputType(InputType.TYPE_CLASS_TEXT
                        | InputType.TYPE_TEXT_FLAG_MULTI_LINE
                        | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
                editText.setSingleLine(false);
                editText.setMinLines(4);
            });
            mStripListPreference.setOnPreferenceChangeListener((preference, newValue) -> {
                String raw = newValue == null ? "" : newValue.toString();
                applyStripList(raw);
                return true;
            });
        }

        setTrackingRadio();

        tintIcons();

    }


    private void setTrackingRadio() {
        if(mSharedPreferences.getBoolean(Preferences.SETTINGS_ANTI_TRACKING_STRICT, false)){
            mStrictPreference.setChecked(true);
        }else if(mSharedPreferences.getBoolean(Preferences.SETTINGS_ANTI_TRACKING_CUSTOM, false)){
            mCustomPreference.setChecked(true);
        }else{
            mDefaultPreference.setChecked(true);
        }
        updateStripListEnabled();
    }


    private void updateStripListEnabled() {
        if(mStripListPreference != null) {
            mStripListPreference.setEnabled(
                    mSharedPreferences.getBoolean(Preferences.SETTINGS_ANTI_TRACKING_CUSTOM, false));
        }
    }


    private void applyStripList(String raw) {
        String trimmed = raw == null ? "" : raw.trim();
        String[] list = trimmed.isEmpty() ? new String[0] : trimmed.split("\\s+");
        mGeckoRuntimeHelper.getGeckoRuntime().getSettings().getContentBlocking()
                .setQueryParameterStrippingStripList(list);
    }


    @Override
    public boolean onPreferenceClick(@NonNull Preference preference) {
        ContentBlocking.Settings cb = mGeckoRuntimeHelper.getGeckoRuntime().getSettings().getContentBlocking();
        if((Preferences.SETTINGS_ANTI_TRACKING_DEFAULT).equals(preference.getKey())){
            mDefaultPreference.toggleRadioButton();
            cb.setAntiTracking(ContentBlocking.AntiTracking.DEFAULT);
            cb.setEnhancedTrackingProtectionLevel(ContentBlocking.EtpLevel.DEFAULT);
            cb.setQueryParameterStrippingEnabled(false);
            cb.setQueryParameterStrippingPrivateBrowsingEnabled(false);
        }else if(Preferences.SETTINGS_ANTI_TRACKING_STRICT.equals(preference.getKey())){
            mStrictPreference.toggleRadioButton();
            cb.setAntiTracking(ContentBlocking.AntiTracking.STRICT | ContentBlocking.AntiTracking.STP);
            cb.setEnhancedTrackingProtectionLevel(ContentBlocking.EtpLevel.STRICT);
            cb.setQueryParameterStrippingEnabled(false);
            cb.setQueryParameterStrippingPrivateBrowsingEnabled(false);
        }else if(Preferences.SETTINGS_ANTI_TRACKING_CUSTOM.equals(preference.getKey())){
            mCustomPreference.toggleRadioButton();
            cb.setAntiTracking(ContentBlocking.AntiTracking.DEFAULT);
            cb.setEnhancedTrackingProtectionLevel(ContentBlocking.EtpLevel.DEFAULT);
            cb.setQueryParameterStrippingEnabled(true);
            cb.setQueryParameterStrippingPrivateBrowsingEnabled(true);
            applyStripList(mSharedPreferences.getString(
                    Preferences.SETTINGS_ANTI_TRACKING_STRIP_LIST,
                    Preferences.DEFAULT_QUERY_STRIP_LIST));
        }
        updateStripListEnabled();
        return false;
    }
}
