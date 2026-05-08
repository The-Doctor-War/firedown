package com.solarized.firedown.geckoview;

import org.mozilla.geckoview.ContentBlocking;

/**
 * Five-bucket grouping over GeckoView's finer-grained
 * {@link ContentBlocking.AntiTracking} bitmask, sized to match the
 * categories Fenix shows on its tracking-protection panel and small
 * enough to render directly in the security bottom sheet.
 *
 * The mapping intentionally collapses {@code AD}, {@code ANALYTIC}
 * and {@code CONTENT} into a single "tracking content" bucket — they
 * are individually too low-signal for users to act on, while the
 * combined count is what most people mean when they say "trackers".
 */
public enum TrackingCategory {
    CROSS_SITE_COOKIES,
    SOCIAL_MEDIA,
    FINGERPRINTERS,
    CRYPTOMINERS,
    TRACKING_CONTENT;

    /**
     * Maps a {@link ContentBlocking.BlockEvent} category bitmask onto a
     * single bucket. Returns {@code null} for events that don't fit any
     * of the displayed categories — caller should ignore them rather
     * than count under "tracking content" (otherwise unrelated test /
     * STP-only flags inflate the visible total).
     */
    public static TrackingCategory fromAntiTrackingMask(int mask) {
        if ((mask & ContentBlocking.AntiTracking.FINGERPRINTING) != 0) {
            return FINGERPRINTERS;
        }
        if ((mask & ContentBlocking.AntiTracking.CRYPTOMINING) != 0) {
            return CRYPTOMINERS;
        }
        if ((mask & (ContentBlocking.AntiTracking.SOCIAL
                | ContentBlocking.AntiTracking.STP)) != 0) {
            return SOCIAL_MEDIA;
        }
        // EMAIL trackers (AntiTracking.EMAIL = 1<<9) ship in the STRICT
        // ETP set users actually enable, so an unmapped EMAIL block
        // would silently never reach the visible total. Bucket under
        // tracking-content rather than minting a sixth UI row — fits
        // the same "non-specific tracker" mental model.
        if ((mask & (ContentBlocking.AntiTracking.AD
                | ContentBlocking.AntiTracking.ANALYTIC
                | ContentBlocking.AntiTracking.CONTENT
                | ContentBlocking.AntiTracking.EMAIL)) != 0) {
            return TRACKING_CONTENT;
        }
        return null;
    }
}
