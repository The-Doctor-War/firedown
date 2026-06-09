package com.solarized.firedown.data.repository;


import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.Log;

import androidx.lifecycle.MutableLiveData;
import com.solarized.firedown.data.entity.BrowserDownloadEntity;
import com.solarized.firedown.utils.BuildUtils;
import com.solarized.firedown.utils.FileUriHelper;
import com.solarized.firedown.utils.WebUtils;

import org.apache.commons.collections4.QueueUtils;
import org.apache.commons.collections4.queue.CircularFifoQueue;
import java.util.Collections;
import java.util.List;
import java.util.Queue;
import java.util.stream.Collectors;
import javax.inject.Inject;
import javax.inject.Singleton;

@Singleton
public class BrowserDownloadRepository {

    private static final String TAG = BrowserDownloadRepository.class.getSimpleName();
    private static final int INTERCEPT_SIZE = 1024;

    /** Max Hamming distance (out of 64 bits) between two image perceptual
     *  hashes for them to count as the same picture. Small enough to avoid
     *  folding distinct images, loose enough to absorb scaling artefacts
     *  between sizes of the same image. */
    private static final int PHASH_MAX_DISTANCE = 8;

    private final Queue<BrowserDownloadEntity> mInterceptedList;
    private final MutableLiveData<List<BrowserDownloadEntity>> mMediatorData;

    /**
     * Coalesces list emissions. A media-heavy page (twitch/kick) can capture
     * 200+ items in a burst, and each {@code addValue} would otherwise re-sort
     * the whole list and dispatch a DiffUtil pass. We emit on the leading edge
     * (the first capture shows instantly) then throttle the rest to one
     * emission per {@link #EMIT_THROTTLE_MS} window (a single trailing flush),
     * collapsing the burst into a handful of updates. The capture sheet's
     * "scanning" spinner already signals ongoing work, so the small batching
     * latency is invisible.
     */
    private static final long EMIT_THROTTLE_MS = 175L;
    private final Object mEmitLock = new Object();
    private final Handler mEmitHandler = new Handler(Looper.getMainLooper());
    private long mLastEmit;
    private boolean mEmitScheduled;
    private final Runnable mEmitRunnable = () -> {
        synchronized (mEmitLock) {
            mEmitScheduled = false;
            mLastEmit = SystemClock.uptimeMillis();
        }
        doEmit();
    };

    @Inject
    public BrowserDownloadRepository() {
        mInterceptedList = QueueUtils.synchronizedQueue(new CircularFifoQueue<>(INTERCEPT_SIZE));
        mMediatorData = new MutableLiveData<>();
    }

    public MutableLiveData<List<BrowserDownloadEntity>> getData() {
        return mMediatorData;
    }

    private boolean isPresent(BrowserDownloadEntity oldEntity, BrowserDownloadEntity newEntity) {
        // Different tab → never the same entry
        if (oldEntity.getTabId() != newEntity.getTabId()) return false;

        // Same uid → exact dup, fast path
        if (oldEntity.getUid() == newEntity.getUid()) return true;

        String oldUrl = oldEntity.getFileUrl();
        String newUrl = newEntity.getFileUrl();
        if (oldUrl == null || newUrl == null) return false;

        // Identical URLs (uid hash collision possible but rare; still a dup)
        if (oldUrl.equals(newUrl)) return true;

        // URLs that differ only in fragment or trailing slash
        if (stripTrivial(oldUrl).equals(stripTrivial(newUrl))) return true;

        String oldMimeType = oldEntity.getMimeType();
        String newMimeType = newEntity.getMimeType();

        if (FileUriHelper.isImage(oldMimeType) && FileUriHelper.isImage(newMimeType)) {
            // Content-based de-dup. The native metadata reader stamps each image
            // with a perceptual hash (dHash) of its pixels; two URLs are the
            // same picture when those hashes are within a small Hamming distance
            // — independent of size, host or CDN, and with no URL-pattern rules.
            // 0 means "not hashed" (flat image / decode skipped), in which case
            // we rely on the exact-URL checks already done above.
            long a = oldEntity.getPHash();
            long b = newEntity.getPHash();
            if (a != 0 && b != 0 && Long.bitCount(a ^ b) <= PHASH_MAX_DISTANCE) {
                return true;
            }
        }

        return false;
    }

    public boolean isEmpty() {
        return mInterceptedList.isEmpty();
    }

    public boolean contains(BrowserDownloadEntity browserDownloadEntity) {
        synchronized (mInterceptedList) {
            for (BrowserDownloadEntity entity : mInterceptedList) {
                if (isPresent(entity, browserDownloadEntity))
                    return true;
            }
            return false;
        }
    }

    public void addValue(BrowserDownloadEntity browserDownloadEntity) {
        boolean added = false;
        boolean upgraded = false;
        synchronized (mInterceptedList) {
            boolean exists = false;
            for (BrowserDownloadEntity entity : mInterceptedList) {
                if (isPresent(entity, browserDownloadEntity)) {
                    exists = true;
                    // Same URL captured twice — keep ONE entry, but let the RICHER
                    // capture's title/thumbnail win regardless of arrival order.
                    upgraded = upgradeMetadata(entity, browserDownloadEntity);
                    break;
                }
            }
            if (!exists) {
                Log.d(TAG, "addValue: " + browserDownloadEntity.getFileUrl() + " tab: " + browserDownloadEntity.getTabId() + " uid: " + browserDownloadEntity.getUid());
                mInterceptedList.add(browserDownloadEntity);
                added = true;
            }
        }
        // Throttled emit, outside the list lock (see scheduleEmit / mEmitRunnable).
        if (added || upgraded) {
            scheduleEmit();
        }
    }

    /**
     * On a same-URL dedup, prefer the RICHER capture's display metadata. When the
     * existing entry is named after its URL — a bare generic catch, e.g. an
     * extensionless {@code /play/video/<token>} the catcher classified by its
     * HEAD content-type — and the incoming capture of the SAME url carries a real
     * title (a parser / page-state-bridge capture), upgrade the existing entity in
     * place instead of dropping the incoming. Order-independent: whoever landed
     * first, the human title wins. Keeps the existing entity's already-working
     * headers/strategy. Returns true if anything changed (→ re-emit).
     */
    private boolean upgradeMetadata(BrowserDownloadEntity existing, BrowserDownloadEntity incoming) {
        boolean changed = false;

        String existingName = existing.getFileName();
        String incomingName = incoming.getFileName();
        boolean existingBare = TextUtils.isEmpty(existingName)
                || existingName.equals(WebUtils.getFileNameFromURL(existing.getFileUrl()));
        boolean incomingRich = !TextUtils.isEmpty(incomingName)
                && !incomingName.equals(WebUtils.getFileNameFromURL(incoming.getFileUrl()));
        if (existingBare && incomingRich && !existing.isFileNameForced()) {
            existing.setFileName(incomingName);
            changed = true;
        }

        if (TextUtils.isEmpty(existing.getFileThumbnail()) && !TextUtils.isEmpty(incoming.getFileThumbnail())) {
            existing.setFileThumbnail(incoming.getFileThumbnail());
            changed = true;
        }
        if (TextUtils.isEmpty(existing.getFileDescription()) && !TextUtils.isEmpty(incoming.getFileDescription())) {
            existing.setFileDescription(incoming.getFileDescription());
            changed = true;
        }
        return changed;
    }

    public void postComplete() {
        // Force an immediate emit (e.g. a download finished) and reset the
        // throttle window so a following capture burst still gets its leading edge.
        synchronized (mEmitLock) {
            mEmitHandler.removeCallbacks(mEmitRunnable);
            mEmitScheduled = false;
            mLastEmit = SystemClock.uptimeMillis();
        }
        doEmit();
    }

    public void postClear() {
        synchronized (mEmitLock) {
            mEmitHandler.removeCallbacks(mEmitRunnable);
            mEmitScheduled = false;
            mLastEmit = SystemClock.uptimeMillis();
        }
        synchronized (mInterceptedList) {
            mInterceptedList.clear();
        }
        mMediatorData.postValue(null);
    }

    public void trimTabs(int tabId) {
        synchronized (mInterceptedList) {
            mInterceptedList.removeIf(entity -> entity.getTabId() == tabId);
        }
    }

    /**
     * Leading + trailing throttle. The first call after a quiet period emits
     * immediately; calls within the window schedule a single trailing flush so
     * a capture burst collapses into one emission per window.
     */
    private void scheduleEmit() {
        synchronized (mEmitLock) {
            long now = SystemClock.uptimeMillis();
            long sinceLast = now - mLastEmit;
            if (sinceLast < EMIT_THROTTLE_MS) {
                if (!mEmitScheduled) {
                    mEmitScheduled = true;
                    mEmitHandler.postDelayed(mEmitRunnable, EMIT_THROTTLE_MS - sinceLast);
                }
                return;
            }
            mEmitHandler.removeCallbacks(mEmitRunnable);
            mEmitScheduled = false;
            mLastEmit = now;
            // leading edge — emit below, outside the lock
        }
        doEmit();
    }

    private void doEmit() {
        List<BrowserDownloadEntity> sortedList;
        // Snapshot+sort under the list lock — the trailing flush runs on the
        // main thread, so it can't rely on a caller already holding it.
        synchronized (mInterceptedList) {
            if (BuildUtils.hasAndroid14()) {
                sortedList = mInterceptedList.stream()
                        .sorted(Collections.reverseOrder())
                        .toList();
            } else {
                sortedList = mInterceptedList.stream()
                        .sorted(Collections.reverseOrder())
                        .collect(Collectors.toList());
            }
        }
        mMediatorData.postValue(sortedList);
    }


    private static String stripTrivial(String url) {
        if (url == null) return "";
        int hash = url.indexOf('#');
        if (hash >= 0) url = url.substring(0, hash);
        if (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

}