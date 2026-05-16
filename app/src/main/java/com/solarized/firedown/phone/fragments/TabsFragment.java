package com.solarized.firedown.phone.fragments;

import android.os.Bundle;
import android.util.Log;
import android.view.View;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.lifecycle.LiveData;

import com.google.android.material.snackbar.Snackbar;
import com.solarized.firedown.BuildConfig;
import com.solarized.firedown.IntentActions;
import com.solarized.firedown.Preferences;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.GeckoStateEntity;
import com.solarized.firedown.geckoview.GeckoState;
import com.solarized.firedown.ui.adapters.BrowserTabsAdapter;
import com.solarized.firedown.utils.NavigationUtils;


import java.util.List;
import java.util.concurrent.TimeUnit;

import dagger.hilt.android.AndroidEntryPoint;

/**
 * Tab switcher for regular (non-incognito) tabs.
 *
 * <p>Adds an archive-banner row at adapter position 0 via the shared
 * {@link BrowserTabsAdapter} (single adapter, two view types — no
 * ConcatAdapter), undo-on-close snackbar, scroll-to-active behavior,
 * and auto-archive of inactive tabs.</p>
 */
@AndroidEntryPoint
public class TabsFragment extends BaseTabsFragment {

    private static final String TAG = TabsFragment.class.getSimpleName();

    /**
     * Flip to true when iterating on the banner UX to make the archive
     * banner show unconditionally on debug builds — useful when there
     * are no archived tabs yet but you want to verify the visual.
     * Wrapped in {@code BuildConfig.DEBUG} at the call site so R8
     * constant-folds it out of release. Default false so debug builds
     * still exercise the real "current &gt; dismissedAt" gate.
     */
    private static final boolean FORCE_BANNER_FOR_DEBUG = false;

    private Snackbar mActiveSnackbar;

    /**
     * Listener installed on the adapter for the banner row. Held as a
     * field so a single instance is reused across re-bind / re-show
     * cycles instead of allocating a new one for every observer tick.
     */
    private final BrowserTabsAdapter.OnBannerActionListener mBannerListener =
            new BrowserTabsAdapter.OnBannerActionListener() {
                @Override
                public void onViewArchive() {
                    snapshotDismissedAt();
                    if (mBrowserTabsAdapter != null) mBrowserTabsAdapter.dismissBanner();
                    refreshEmptyVisibility();
                    NavigationUtils.navigateSafe(mNavController, R.id.tabs_archive);
                }

                @Override
                public void onDismiss() {
                    snapshotDismissedAt();
                    if (mBrowserTabsAdapter != null) mBrowserTabsAdapter.dismissBanner();
                    refreshEmptyVisibility();
                }
            };

    @Override
    public void onDestroyView() {
        if (mActiveSnackbar != null) {
            mActiveSnackbar.dismiss();
            mActiveSnackbar = null;
        }
        mToolbar = null;
        super.onDestroyView();
    }


    // ── Abstract implementations ─────────────────────────────────────

    @Override
    protected LiveData<List<GeckoStateEntity>> getTabsLiveData() {
        return mGeckoStateViewModel.getTabs();
    }

    @Override
    protected GeckoState getGeckoState(int tabId) {
        return mGeckoStateViewModel.getGeckoState(tabId);
    }

    @Override
    protected void activateGeckoState(GeckoState geckoState) {
        mGeckoStateViewModel.setGeckoState(geckoState, true);
    }

    @Override
    protected void removeGeckoState(GeckoState geckoState) {
        mGeckoStateViewModel.closeGeckoState(geckoState);
    }

    @Override
    protected int getEmptyTextRes() {
        return R.string.browser_tabs_empty;
    }

    @Override
    protected void onTabSelected(GeckoStateEntity entity, GeckoState geckoState) {
        if (entity.isHome()) {
            getParentFragmentManager().setFragmentResult(
                    TabsHolderFragment.KEY_SELECT_HOME, Bundle.EMPTY);
        } else {
            mBrowserURIViewModel.onEventSelected(
                    geckoState.getGeckoStateEntity(), IntentActions.OPEN_SESSION);
            Bundle args = new Bundle();
            args.putBoolean("incognito", false);
            getParentFragmentManager().setFragmentResult(
                    TabsHolderFragment.KEY_SELECT_BROWSER, args);
        }
    }

    @Override
    protected void onTabClosed(GeckoStateEntity entity, GeckoState geckoState) {
        mActiveSnackbar = makeSnackbar(getString(R.string.snackbar_tab_closed));
        mActiveSnackbar.setAction(R.string.snackbar_deleted_undo, view ->
                mGeckoStateViewModel.setGeckoState(geckoState, true));
        mActiveSnackbar.addCallback(new Snackbar.Callback() {
            @Override
            public void onDismissed(Snackbar transientBottomBar, int event) {
                if (event != DISMISS_EVENT_ACTION) {
                    geckoState.closeGeckoSession();
                }
            }
        });
        mActiveSnackbar.show();
    }

    // adjustPosition / getLeadingAdapterCount come from BaseTabsFragment now;
    // both delegate to BrowserTabsAdapter#getPositionOffset which is the
    // single source of truth for "is the banner row in the way?"

    // setupRecyclerView is inherited unchanged — the base attaches the
    // single BrowserTabsAdapter directly. The banner span-full-width
    // rule lives in the base's SpanSizeLookup (keyed off the adapter's
    // view type), so it works for both regular and incognito tabs even
    // though only TabsFragment ever shows a banner.

    @Override
    protected boolean awaitsBannerSignal() {
        // The archived-tab-count LiveData is a separate Room query
        // that lands after the tab-list LiveData, so the initial
        // scroll has to hold until we know whether the banner row
        // will be present at adapter position 0 — otherwise we
        // place the active row, then the banner inserts, then every
        // tab shifts down by one and the user sees a one-row jump.
        return true;
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);

        Log.d(TAG, "onViewCreated");

        // Archive banner observer — windowed by the user's auto-archive
        // interval (day / week / month). The banner shows the count of
        // tabs archived within that window so it stays small and
        // actionable, instead of growing forever with the all-time
        // archive count.
        long intervalMs = mSharedPreferences.getLong(
                Preferences.SETTINGS_TABS_ARCHIVE_INTERVAL,
                Preferences.ONE_WEEK_INTERVAL);
        long sinceMs = System.currentTimeMillis() - intervalMs;
        final int titlePluralsRes = bannerTitlePluralsFor(intervalMs);

        mGeckoStateViewModel.getArchivedTabCountSince(sinceMs)
                .observe(getViewLifecycleOwner(), count -> {
                    if (mBrowserTabsAdapter == null) return;
                    int current = count != null ? count : 0;
                    int dismissedAt = mSharedPreferences.getInt(
                            Preferences.SETTINGS_TABS_ARCHIVE_BANNER_DISMISSED_AT, 0);
                    // Debug-only forced banner: stripped from release
                    // builds by the constant-folding R8 does on
                    // BuildConfig.DEBUG. Floors the count to 7 so the
                    // banner shows even when the archive is empty.
                    if (BuildConfig.DEBUG && FORCE_BANNER_FOR_DEBUG) {
                        mBrowserTabsAdapter.showBanner(
                                Math.max(current, 7), titlePluralsRes, mBannerListener);
                    } else if (current > dismissedAt) {
                        mBrowserTabsAdapter.showBanner(current, titlePluralsRes, mBannerListener);
                    } else {
                        mBrowserTabsAdapter.dismissBanner();
                    }
                    // The empty-state check has to be re-run whenever the
                    // banner toggles: with no tabs and the banner showing
                    // the recycler still has content (just the banner row),
                    // and dismissing the banner with no tabs flips us back
                    // to the empty placeholder.
                    refreshEmptyVisibility();
                    // Release the initial-scroll gate now that the banner
                    // state is known. Idempotent — only the first emission
                    // here actually opens the gate; later changes (banner
                    // dismissed via tap, count refreshed) skip the gate
                    // path entirely.
                    markBannerResolved();
                });

        // Debounced auto-archive trigger
        boolean autoArchiveEnabled = mSharedPreferences.getBoolean(
                Preferences.SETTINGS_TABS_ARCHIVE, true);

        if (autoArchiveEnabled) {
            long lastRun = mSharedPreferences.getLong(Preferences.SETTINGS_TABS_ARCHIVE_LAST_RUN, 0);
            long now = System.currentTimeMillis();
            if (now - lastRun > TimeUnit.HOURS.toMillis(6)) {
                long thresholdMillis = mSharedPreferences.getLong(
                        Preferences.SETTINGS_TABS_ARCHIVE_INTERVAL,
                        Preferences.ONE_WEEK_INTERVAL);
                mGeckoStateViewModel.archiveInactiveTabs(thresholdMillis);
                mSharedPreferences.edit()
                        .putLong(Preferences.SETTINGS_TABS_ARCHIVE_LAST_RUN, now)
                        .apply();
            }
        }
    }


    /**
     * Persists the current archived-tab count as the "I've seen this"
     * snapshot. The banner observer compares the live count against
     * this value, so the banner only re-appears if more tabs land in
     * the archive after dismissal.
     */
    private void snapshotDismissedAt() {
        Integer live = mGeckoStateViewModel.getArchivedTabCount().getValue();
        int current = live != null ? live : 0;
        mSharedPreferences.edit()
                .putInt(Preferences.SETTINGS_TABS_ARCHIVE_BANNER_DISMISSED_AT, current)
                .apply();
    }

    /**
     * Maps the user's auto-archive interval to the matching plurals
     * resource for the banner title. Falls through to "this week" for
     * any unusual / custom interval value so translators only have to
     * cover the three canonical periods.
     */
    private static int bannerTitlePluralsFor(long intervalMs) {
        if (intervalMs <= Preferences.ONE_DAY_INTERVAL) {
            return R.plurals.archive_banner_title_day;
        }
        if (intervalMs >= Preferences.THIRTY_DAYS_INTERVAL) {
            return R.plurals.archive_banner_title_month;
        }
        return R.plurals.archive_banner_title_week;
    }

    // ── Snackbar helper ─────────────────────────────────────────────

    private Snackbar makeSnackbar(String text) {
        View coordinator = getParentFragment() != null && getParentFragment().getView() != null
                ? getParentFragment().getView().findViewById(R.id.coordinator_root)
                : mRecyclerView;
        View fab = getParentFragment() != null && getParentFragment().getView() != null
                ? getParentFragment().getView().findViewById(R.id.fab_new_tab)
                : null;

        Snackbar snackbar = Snackbar.make(coordinator, text, Snackbar.LENGTH_LONG);
        if (fab != null) snackbar.setAnchorView(fab);
        return snackbar;
    }
}