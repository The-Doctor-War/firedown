package com.solarized.firedown.phone.dialogs;

import android.os.Bundle;
import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.CompoundButton;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.widget.AppCompatImageView;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.ViewModelProvider;
import androidx.transition.AutoTransition;
import androidx.transition.TransitionManager;

import com.bumptech.glide.load.resource.bitmap.RoundedCorners;
import com.bumptech.glide.request.RequestOptions;
import com.google.android.material.materialswitch.MaterialSwitch;
import com.solarized.firedown.GlideHelper;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.CertificateInfoEntity;
import com.solarized.firedown.data.models.GeckoStateViewModel;
import com.solarized.firedown.data.models.IncognitoStateViewModel;
import com.solarized.firedown.geckoview.GeckoResources;
import com.solarized.firedown.geckoview.GeckoState;
import com.solarized.firedown.geckoview.TrackingCategory;
import com.solarized.firedown.Keys;
import com.solarized.firedown.utils.NavigationUtils;
import com.solarized.firedown.utils.UrlStringUtils;
import com.solarized.firedown.utils.WebUtils;

import java.util.Map;

public class SecurityStateSheetDialogFragment extends BaseBottomSheetDialogFragment
        implements View.OnClickListener, CompoundButton.OnCheckedChangeListener {

    private GeckoStateViewModel mGeckoStateViewModel;
    private IncognitoStateViewModel mIncognitoStateViewModel;
    private GeckoState mGeckoState;
    private CertificateInfoEntity mCertificateInfoEntity;
    private TextView mAdsCounterTextView;
    private MaterialSwitch mAdsSwitch;
    private MaterialSwitch mTrackingSwitch;
    private TextView mTrackingSubtext;
    private TextView mHostText;
    private View mHostCert;
    private AppCompatImageView mTrackingIcon;
    private View mBlockedTrackersSection;
    private View mBlockedTrackersSummaryRow;
    private TextView mBlockedTrackersSummaryText;
    private AppCompatImageView mBlockedTrackersChevron;
    private View mBlockedTrackersList;
    private View mRowCrossSiteCookies;
    private View mRowSocialMedia;
    private View mRowFingerprinters;
    private View mRowCryptominers;
    private View mRowTrackingContent;
    private boolean mBlockedTrackersExpanded;
    private boolean mTrackingEnabledForSite;

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        mGeckoStateViewModel = new ViewModelProvider(mActivity).get(GeckoStateViewModel.class);
        mIncognitoStateViewModel = new ViewModelProvider(mActivity).get(IncognitoStateViewModel.class);

        Bundle bundle = getArguments();

        if (bundle == null)
            throw new IllegalArgumentException("Bundle null");

        mGeckoState = mIsIncognito
                ? mIncognitoStateViewModel.peekCurrentGeckoState()
                : mGeckoStateViewModel.peekCurrentGeckoState();

        if (mGeckoState == null) {
            dismiss();
            return;
        }

        mCertificateInfoEntity = mGeckoState.getCertificateState();
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {

        LayoutInflater themedInflater = container != null
                ? LayoutInflater.from(container.getContext())
                : inflater;

        mView = themedInflater.inflate(R.layout.fragment_dialog_security, container, false);

        mTrackingIcon = mView.findViewById(R.id.tracking_icon);
        mTrackingSwitch = mView.findViewById(R.id.tracking_toogle);
        mTrackingSubtext = mView.findViewById(R.id.tracking_subtext);
        mAdsCounterTextView = mView.findViewById(R.id.ads_counter);
        mAdsSwitch = mView.findViewById(R.id.ads_toogle);
        mHostText = mView.findViewById(R.id.host_secure_text);
        mHostCert = mView.findViewById(R.id.host_secure);
        mBlockedTrackersSection = mView.findViewById(R.id.blocked_trackers_section);
        mBlockedTrackersSummaryRow = mView.findViewById(R.id.blocked_trackers_summary_row);
        mBlockedTrackersSummaryText = mView.findViewById(R.id.blocked_trackers_summary_text);
        mBlockedTrackersChevron = mView.findViewById(R.id.blocked_trackers_chevron);
        mBlockedTrackersList = mView.findViewById(R.id.blocked_trackers_list);
        mRowCrossSiteCookies = mView.findViewById(R.id.row_cross_site_cookies);
        mRowSocialMedia = mView.findViewById(R.id.row_social_media);
        mRowFingerprinters = mView.findViewById(R.id.row_fingerprinters);
        mRowCryptominers = mView.findViewById(R.id.row_cryptominers);
        mRowTrackingContent = mView.findViewById(R.id.row_tracking_content);

        mBlockedTrackersSummaryRow.setOnClickListener(v -> toggleBlockedTrackersExpanded());

        bindBlockedRow(mRowCrossSiteCookies,
                R.string.blocked_trackers_cross_site_cookies);
        bindBlockedRow(mRowSocialMedia,
                R.string.blocked_trackers_social_media);
        bindBlockedRow(mRowFingerprinters,
                R.string.blocked_trackers_fingerprinters);
        bindBlockedRow(mRowCryptominers,
                R.string.blocked_trackers_cryptominers);
        bindBlockedRow(mRowTrackingContent,
                R.string.blocked_trackers_tracking_content);

        mTrackingSwitch.setOnCheckedChangeListener(this);
        mAdsSwitch.setOnCheckedChangeListener(this);

        TextView host = mView.findViewById(R.id.host);
        TextView hostUrl = mView.findViewById(R.id.host_url);

        AppCompatImageView hostImage = mView.findViewById(R.id.host_image);

        View hostClear = mView.findViewById(R.id.host_clear);

        hostClear.setOnClickListener(this);
        mHostCert.setOnClickListener(this);

        String url;
        String domain;

        if (mCertificateInfoEntity != null) {
            url = mCertificateInfoEntity.url;
            domain = mCertificateInfoEntity.host;
        } else {
            url = mGeckoState.getEntityUri();
            domain = WebUtils.getDomainName(url);
        }

        mHostCert.setEnabled(mCertificateInfoEntity != null);

        host.setText(GeckoResources.isOnboarding(url) ? GeckoResources.ABOUT_ONBOARDING : mGeckoState.getEntityTitle());
        hostUrl.setText(domain);

        boolean isSecure = mCertificateInfoEntity != null && mCertificateInfoEntity.isSecure;

        hostClear.setEnabled(isUrlValidForCleaning(domain));

        mHostText.setText(isSecure ? R.string.quick_settings_sheet_secure_connection_2 : R.string.quick_settings_sheet_insecure_connection_2);
        mHostText.setCompoundDrawablesRelativeWithIntrinsicBounds(
                isSecure ? R.drawable.encryption_light_24 : R.drawable.no_encryption_light_24, 0, 0, 0);

        loadFavicon(hostImage, domain);

        // Ads count — routed to the correct per-mode stream so the incognito
        // sheet never reflects counts from regular browsing and vice versa.
        // Both streams are backed by the same GeckoUblockHelper singleton;
        // GeckoRuntimeHelper.handleUblockMessage decides which one to post
        // into based on the sending GeckoSession's incognito-ness.
        LiveData<String> adsCountLive = mIsIncognito
                ? mIncognitoStateViewModel.getAdsCount()
                : mGeckoStateViewModel.getAdsCount();

        adsCountLive.observe(getViewLifecycleOwner(), count -> {
            mAdsCounterTextView.setText(String.valueOf(count));
        });

        // Ads filter enabled state is a per-URL whitelist concept (netWhitelist
        // Map in µb), not per-mode. Always read from the regular ViewModel.
        mGeckoStateViewModel.isAdsFilterEnabled().observe(getViewLifecycleOwner(), active -> {
            mAdsSwitch.setChecked(active);
        });

        // Tracking protection — delegate to the correct ViewModel.
        // In incognito mode this uses an ephemeral in-memory set so
        // domain exceptions are never persisted to disk.
        boolean trackingEnabled = mIsIncognito
                ? mIncognitoStateViewModel.isTrackingProtected(mGeckoState.getEntityUri())
                : mGeckoStateViewModel.isTrackingProtected(mGeckoState.getEntityUri());

        updateTrackingUI(trackingEnabled);

        // Per-page blocked-trackers breakdown. The repository's LiveData
        // is "current tab's counts" but it can carry a stale value from
        // whichever tab last emitted before this one was activated, so
        // ask the ViewModel to re-emit the snapshot for *this* tab
        // before subscribing.
        if (mIsIncognito) {
            mIncognitoStateViewModel.refreshBlockedTrackerCounts();
            mIncognitoStateViewModel.getBlockedTrackerCounts()
                    .observe(getViewLifecycleOwner(), this::renderBlockedTrackerCounts);
        } else {
            mGeckoStateViewModel.refreshBlockedTrackerCounts();
            mGeckoStateViewModel.getBlockedTrackerCounts()
                    .observe(getViewLifecycleOwner(), this::renderBlockedTrackerCounts);
        }

        return mView;
    }


    private void bindBlockedRow(View row, int labelRes) {
        if (row == null) return;
        TextView label = row.findViewById(R.id.row_label);
        if (label != null) label.setText(labelRes);
    }


    private void renderBlockedTrackerCounts(Map<TrackingCategory, Integer> counts) {
        if (mBlockedTrackersSection == null) return;

        int total = 0;
        if (counts != null) {
            for (Integer v : counts.values()) {
                if (v != null) total += v;
            }
        }

        // Hide the whole expandable section when:
        //   - the user has added a tracking exception for this site
        //     (counts wouldn't be meaningful — events stop firing), or
        //   - the page hasn't blocked anything yet.
        // The toggle row above keeps showing the existing subtext in
        // both cases, so the dialog still has something useful in it.
        if (!mTrackingEnabledForSite || total == 0) {
            mBlockedTrackersSection.setVisibility(View.GONE);
            return;
        }

        mBlockedTrackersSection.setVisibility(View.VISIBLE);
        mBlockedTrackersSummaryText.setText(getResources().getQuantityString(
                R.plurals.blocked_trackers_summary, total, total));

        applyRow(mRowCrossSiteCookies, counts.get(TrackingCategory.CROSS_SITE_COOKIES));
        applyRow(mRowSocialMedia,      counts.get(TrackingCategory.SOCIAL_MEDIA));
        applyRow(mRowFingerprinters,   counts.get(TrackingCategory.FINGERPRINTERS));
        applyRow(mRowCryptominers,     counts.get(TrackingCategory.CRYPTOMINERS));
        applyRow(mRowTrackingContent,  counts.get(TrackingCategory.TRACKING_CONTENT));

        // Apply the latest expanded state to the list — the user could
        // have toggled it open before more blocks streamed in, in which
        // case we want the list to stay open and just re-render.
        applyExpandedState(false);
    }


    private void applyRow(View row, Integer count) {
        if (row == null) return;
        int n = count == null ? 0 : count;
        // Hide categories with zero blocks — keeps the panel from looking
        // padded with placeholders on pages where only one category fired.
        if (n <= 0) {
            row.setVisibility(View.GONE);
            return;
        }
        row.setVisibility(View.VISIBLE);
        TextView countView = row.findViewById(R.id.row_count);
        if (countView != null) countView.setText(String.valueOf(n));
    }


    private void toggleBlockedTrackersExpanded() {
        mBlockedTrackersExpanded = !mBlockedTrackersExpanded;
        applyExpandedState(true);
    }


    private void applyExpandedState(boolean animate) {
        if (mBlockedTrackersList == null) return;
        if (animate) {
            ViewParent parent = mBlockedTrackersList.getParent();
            if (parent instanceof ViewGroup) {
                TransitionManager.beginDelayedTransition(
                        (ViewGroup) parent, new AutoTransition().setDuration(180));
            }
        }
        mBlockedTrackersList.setVisibility(mBlockedTrackersExpanded ? View.VISIBLE : View.GONE);
        mBlockedTrackersChevron.setImageResource(mBlockedTrackersExpanded
                ? R.drawable.expand_less_24
                : R.drawable.expand_more_24);
    }


    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);

        // Observe the correct certificate LiveData based on mode
        MutableLiveData<CertificateInfoEntity> certLiveData = mIsIncognito
                ? mIncognitoStateViewModel.getCertificateData()
                : mGeckoStateViewModel.getCertificateData();

        certLiveData.observe(this, certificateInfoEntity -> {
            if (certificateInfoEntity == null || mCertificateInfoEntity != null)
                return;
            mCertificateInfoEntity = certificateInfoEntity;
            boolean isSecure = certificateInfoEntity.isSecure;
            mHostText.setText(isSecure ? R.string.quick_settings_sheet_secure_connection_2 : R.string.quick_settings_sheet_insecure_connection_2);
            mHostText.setCompoundDrawablesRelativeWithIntrinsicBounds(
                    isSecure ? R.drawable.encryption_light_24 : R.drawable.no_encryption_light_24, 0, 0, 0);
            mHostCert.setEnabled(true);
        });
    }

    @Override
    public void onCheckedChanged(@NonNull CompoundButton buttonView, boolean isChecked) {
        if (!buttonView.isPressed()) return;

        int id = buttonView.getId();
        if (id == R.id.ads_toogle) {
            mGeckoRuntimeHelper.setAds(isChecked);
        } else if (id == R.id.tracking_toogle) {
            if (mIsIncognito) {
                mIncognitoStateViewModel.toggleTrackingProtection(mGeckoState, isChecked);
            } else {
                mGeckoStateViewModel.toggleTrackingProtection(mGeckoState, isChecked);
            }
            updateTrackingUI(isChecked);
        }
    }

    private void updateTrackingUI(boolean isEnabled) {
        mTrackingEnabledForSite = isEnabled;
        mTrackingSwitch.setChecked(isEnabled);
        mTrackingIcon.setImageResource(isEnabled ? R.drawable.ic_shield_24 : R.drawable.ic_shield_privacy_tip_24);
        mTrackingSubtext.setText(isEnabled ?
                R.string.protection_panel_etp_toggle_enabled_description_2 :
                R.string.protection_panel_etp_toggle_disabled_description_2);
        // When the user flips the per-site toggle off we drop the
        // breakdown immediately — its counts are stale the moment we
        // stop applying ETP, and re-showing them would look like an
        // exception is still being protected.
        if (!isEnabled && mBlockedTrackersSection != null) {
            mBlockedTrackersSection.setVisibility(View.GONE);
        }
    }

    @Override
    public void onClick(View v) {
        int id = v.getId();
        if (id == R.id.host_clear) {
            Bundle bundle = new Bundle();
            bundle.putString(Keys.ITEM_ID, mCertificateInfoEntity.host);
            bundle.putBoolean(Keys.IS_INCOGNITO, mIsIncognito);
            NavigationUtils.navigateSafe(mNavController, R.id.action_security_to_clear, bundle);
        } else if (id == R.id.host_secure) {
            Bundle bundle = new Bundle();
            bundle.putParcelable(Keys.ITEM_ID, mCertificateInfoEntity);
            bundle.putBoolean(Keys.IS_INCOGNITO, mIsIncognito);
            NavigationUtils.navigateSafe(mNavController, R.id.action_security_to_cert, bundle);
        }
    }


    private void loadFavicon(AppCompatImageView imageView, String domain) {
        int radius = getResources().getDimensionPixelOffset(R.dimen.icon_rounded);
        String fullDomain;
        String iconUrl = mGeckoState.getEntityIcon();
        if (TextUtils.isEmpty(domain)) {
            fullDomain = null;
        } else {
            fullDomain = domain.startsWith("http") ? domain : "https://" + domain;
        }
        GlideHelper.load(iconUrl, fullDomain, imageView, RequestOptions.bitmapTransform(new RoundedCorners(radius)));
    }

    private boolean isUrlValidForCleaning(String domain) {
        return UrlStringUtils.isURLLike(domain) &&
                !UrlStringUtils.isURLResouceLike(domain) &&
                !UrlStringUtils.isAboutBlank(domain);
    }


    @Override
    public void onDestroyView() {
        super.onDestroyView();
        mHostCert = null;
        mHostText = null;
        mAdsSwitch = null;
        mTrackingSwitch = null;
        mAdsCounterTextView = null;
        mTrackingIcon = null;
        mTrackingSubtext = null;
        mBlockedTrackersSection = null;
        mBlockedTrackersSummaryRow = null;
        mBlockedTrackersSummaryText = null;
        mBlockedTrackersChevron = null;
        mBlockedTrackersList = null;
        mRowCrossSiteCookies = null;
        mRowSocialMedia = null;
        mRowFingerprinters = null;
        mRowCryptominers = null;
        mRowTrackingContent = null;
        mView = null;
    }
}