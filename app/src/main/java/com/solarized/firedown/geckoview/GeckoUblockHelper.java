package com.solarized.firedown.geckoview;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;
import android.util.Log;

import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.preference.PreferenceManager;

import dagger.hilt.android.qualifiers.ApplicationContext;

import javax.inject.Inject;
import javax.inject.Singleton;

/**
 * Helper class to manage uBlock Origin state and communication.
 * Refactored to use Hilt and LiveData for reactive UI updates.
 */
@Singleton
public class GeckoUblockHelper {

    private static final String TAG = GeckoUblockHelper.class.getSimpleName();
    // LiveData streams for the UI to observe.
    //
    // Ads-blocked count is per-mode so the incognito toolbar never
    // reflects counts from regular browsing and vice versa. Callers
    // that know the session's incognito-ness should call
    // onAdsCount(count, isIncognito); the no-arg overload exists for
    // legacy callers and routes to the regular stream.
    private final MutableLiveData<String> mAdsBlockedLive = new MutableLiveData<>("0");
    private final MutableLiveData<String> mAdsBlockedLiveIncognito = new MutableLiveData<>("0");
    /** Cumulative blocked requests since uBlock was installed.
     *  Source of truth lives in {@code µb.requestStats.blockedCount}
     *  inside the extension — firedown.js pushes the value over the
     *  native message bus on load + every firewall update + a coarse
     *  60s interval. Reads here are just a relay. Incognito sessions
     *  don't contribute (uBlock excludes them from its persisted
     *  stats). */
    private final MutableLiveData<Long> mCumulativeBlockedLive = new MutableLiveData<>(0L);
    /** Blocked count since the start of the current calendar day.
     *  Derived from {@code cumulative - baselineAtMidnight}; baseline
     *  rolls forward on the first push of a new day. Gives the info
     *  sheet a 'X today, Y since install' framing without persistent
     *  per-event storage. */
    private final MutableLiveData<Long> mTodayBlockedLive = new MutableLiveData<>(0L);

    // Firewall activation is a global user preference — not per-mode.
    private final MutableLiveData<Boolean> mFirewallActiveLive = new MutableLiveData<>();

    // Internal state variables — written from extension callbacks (potentially
    // background) and read from UI getters; volatile guarantees visibility.
    private volatile boolean mJavascriptDisabled;
    private volatile boolean mFontsDisabled;
    private volatile boolean mMediaDisabled;

    private final SharedPreferences mPrefs;

    /** Persists the last known cumulative-blocked count so the Home
     *  card has something to show on cold start, before uBlock has
     *  initialised (which only happens when a tab opens, not when
     *  the user lands on Home). The card shows the cached value
     *  immediately; the live value overrides it the moment the
     *  extension pushes a fresh number. */
    private static final String KEY_CUMULATIVE_BLOCKED = "ublock.cumulative.blocked";
    private static final String KEY_DAY_BASELINE_DATE  = "ublock.day.baseline.date";
    private static final String KEY_DAY_BASELINE_COUNT = "ublock.day.baseline.count";

    @Inject
    public GeckoUblockHelper(@ApplicationContext Context context) {
        mPrefs = PreferenceManager.getDefaultSharedPreferences(context);
        long cachedBlocked = mPrefs.getLong(KEY_CUMULATIVE_BLOCKED, 0L);
        if (cachedBlocked > 0L) mCumulativeBlockedLive.postValue(cachedBlocked);
        // Seed today's count from the cached baseline so the sheet
        // has something to show on cold start before the extension
        // pushes a fresh cumulative. If the baseline is for an older
        // date the next push will roll it forward; meanwhile this
        // value is at worst stale, not wrong.
        String savedDate = mPrefs.getString(KEY_DAY_BASELINE_DATE, null);
        if (cachedBlocked > 0L && todayKey().equals(savedDate)) {
            long baseline = mPrefs.getLong(KEY_DAY_BASELINE_COUNT, cachedBlocked);
            mTodayBlockedLive.postValue(Math.max(0L, cachedBlocked - baseline));
        }
    }


    /**
     * @return LiveData containing the current ads/trackers blocked count string
     * for regular browsing.
     */
    public LiveData<String> getAdsBlockedLive() {
        return mAdsBlockedLive;
    }

    /**
     * @return LiveData containing the current ads/trackers blocked count string
     * for incognito browsing.
     */
    public LiveData<String> getAdsBlockedLiveIncognito() {
        return mAdsBlockedLiveIncognito;
    }

    /**
     * @return LiveData containing the current activation status of the uBlock firewall.
     */
    public LiveData<Boolean> getFirewallActiveLive() {
        return mFirewallActiveLive;
    }


    // Cookie-notice blocking is a global filter-list selection, not per-hostname.
    // Reflects whether fanboy-cookiemonster is in µb.selectedFilterLists.
    private final MutableLiveData<Boolean> mCookieNoticesBlockedLive = new MutableLiveData<>(false);

    // --- State Management ---

    /**
     * @return LiveData carrying the cumulative blocked-request count
     * since install. Updates whenever firedown.js relays a fresh
     * value from {@code µb.requestStats.blockedCount}.
     */
    public LiveData<Long> getCumulativeBlockedLive() {
        return mCumulativeBlockedLive;
    }

    /**
     * Called from {@code handleUblockMessage} when the extension pushes
     * a fresh cumulative-blocked count. Just relays — uBlock owns the
     * source of truth, including legitimate resets when the user
     * clears the request-stats counter. Caches to SharedPreferences
     * so the Home card has something to show on the next cold start
     * before the extension finishes loading.
     */
    public void onCumulativeBlocked(long blocked) {
        if (blocked < 0) return;
        mCumulativeBlockedLive.postValue(blocked);

        // Roll the day baseline if we've crossed midnight since the
        // last push. Baseline = the cumulative value the day started
        // at, so 'today' = current - baseline. Storing date as ISO
        // yyyy-MM-dd keeps the comparison locale-stable. clamp to
        // zero so a clock skew (user winds backwards, cumulative
        // suddenly < baseline) doesn't render a negative count.
        String today = todayKey();
        String savedDate = mPrefs.getString(KEY_DAY_BASELINE_DATE, null);
        long baseline = mPrefs.getLong(KEY_DAY_BASELINE_COUNT, blocked);
        SharedPreferences.Editor editor = mPrefs.edit().putLong(KEY_CUMULATIVE_BLOCKED, blocked);
        if (!today.equals(savedDate)) {
            baseline = blocked;
            editor.putString(KEY_DAY_BASELINE_DATE, today)
                  .putLong(KEY_DAY_BASELINE_COUNT, baseline);
        }
        editor.apply();
        mTodayBlockedLive.postValue(Math.max(0L, blocked - baseline));
    }

    public LiveData<Long> getTodayBlockedLive() {
        return mTodayBlockedLive;
    }

    private static String todayKey() {
        java.util.Calendar c = java.util.Calendar.getInstance();
        return String.format(java.util.Locale.US, "%04d-%02d-%02d",
                c.get(java.util.Calendar.YEAR),
                c.get(java.util.Calendar.MONTH) + 1,
                c.get(java.util.Calendar.DAY_OF_MONTH));
    }

    /**
     * Session-aware ads count. Routes to the correct per-mode stream.
     */
    public void onAdsCount(String count, boolean isIncognito) {
        String value = TextUtils.isEmpty(count) ? "0" : count;
        if (isIncognito) {
            mAdsBlockedLiveIncognito.postValue(value);
        } else {
            mAdsBlockedLive.postValue(value);
        }
    }

    /**
     * @return LiveData containing the current state of cookie-notice list
     * selection. True when fanboy-cookiemonster is selected.
     */
    public LiveData<Boolean> getCookieNoticesBlockedLive() {
        return mCookieNoticesBlockedLive;
    }


    /**
     * Called when the uBlock firewall settings change.
     */
    public void onFirewallChanged(boolean activated, boolean javascriptDisabled,
                                  boolean mediaDisabled, boolean fontsDisabled,
                                  boolean cookieNoticesBlocked) {

        Log.d(TAG, "onFirewallChanged: " + activated);
        mFirewallActiveLive.postValue(activated);
        this.mJavascriptDisabled = javascriptDisabled;
        this.mMediaDisabled = mediaDisabled;
        this.mFontsDisabled = fontsDisabled;
        mCookieNoticesBlockedLive.postValue(cookieNoticesBlocked);
    }

    // --- Standard Getters & Setters ---


    public boolean isActivated() {
        Boolean active = mFirewallActiveLive.getValue();
        return active != null && active;
    }

    public boolean isJavascriptDisabled() {
        return mJavascriptDisabled;
    }

    public void setJavascriptDisabled(boolean javascriptDisabled) {
        this.mJavascriptDisabled = javascriptDisabled;
    }

    public boolean isFontsDisabled() {
        return mFontsDisabled;
    }

    public void setFontsDisabled(boolean fontsDisabled) {
        this.mFontsDisabled = fontsDisabled;
    }

    public boolean isMediaDisabled() {
        return mMediaDisabled;
    }

    public void setMediaDisabled(boolean mediaDisabled) {
        this.mMediaDisabled = mediaDisabled;
    }

    /**
     * Resets the helper state (e.g., when a new session starts or engine is cleared).
     */
    public void clear() {
        Log.d(TAG, "onFirewallChanged clear");
        mAdsBlockedLive.postValue("0");
        mAdsBlockedLiveIncognito.postValue("0");
        mFirewallActiveLive.postValue(false);
        mJavascriptDisabled = false;
        mFontsDisabled = false;
        mMediaDisabled = false;
        mCookieNoticesBlockedLive.postValue(false);
    }
}