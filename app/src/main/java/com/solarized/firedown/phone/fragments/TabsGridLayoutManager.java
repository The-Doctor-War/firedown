package com.solarized.firedown.phone.fragments;

import android.content.Context;

import androidx.annotation.Nullable;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

/**
 * GridLayoutManager that exposes a "scroll to this position on first
 * paint" hook and disables predictive item animations.
 *
 * <p><b>Disabling predictive animations.</b> The tabs grid doesn't
 * visually animate insertions or removals — cards just appear or
 * disappear. With predictive animations on,
 * {@code notifyItemRangeChanged} with a payload (e.g. an active tab's
 * thumbnail loading after the page is already on screen) triggers a
 * pre-layout pass followed by a real layout pass. Between the two
 * passes the LM resets {@code mAnchorInfo.mValid}, so the post-layout
 * pass re-runs {@code updateAnchorFromChildren} — which iterates
 * {@code mChildHelper} indices, not adapter positions. The
 * scrap/reattach of the changed view holder shuffles those indices,
 * the "first reference child" picked during step 2 isn't the same one
 * step 1 anchored on, and the viewport drifts by one row. Returning
 * {@code false} from {@code supportsPredictiveItemAnimations} tells
 * RecyclerView to skip step 1 entirely — single layout pass per
 * notify, no anchor drift.
 *
 * <p><b>Trust-the-first-layout hook.</b> With predictive animations
 * off, every {@code scrollToPositionWithOffset} produces exactly one
 * layout pass that's free to honor the request, clamp it, or end up
 * wherever the LM thinks is best given the dataset and viewport
 * shape. We accept whatever it produces — there's no second pass
 * waiting to override it. {@code setInitialPosition} queues the
 * scroll and arms a one-shot waiting flag; the very next non-pre
 * {@code onLayoutCompleted} fires the {@code onReached} callback
 * regardless of {@code findFirstVisibleItemPosition()}'s value.
 * No retry loop, no convergence checks, no escape hatches: if the
 * LM can place the active row at the requested offset it will, and
 * if it has to clamp it'll still leave the active row in view
 * (that's what clamping does — the dataset's bottom-most rows are
 * shown).
 */
public class TabsGridLayoutManager extends GridLayoutManager {

    private int mScrollTarget = RecyclerView.NO_POSITION;
    @Nullable private Runnable mOnReached;
    private boolean mWaitingForFirstLayout = false;

    public TabsGridLayoutManager(Context context, int spanCount) {
        super(context, spanCount);
    }

    @Override
    public boolean supportsPredictiveItemAnimations() {
        return false;
    }

    /**
     * Request a one-shot scroll to {@code scrollTarget} and fire
     * {@code onReached} on the next non-pre-layout pass. The callback
     * fires regardless of whether the LM was able to honor the
     * request exactly — callers (the holder postpone-release in
     * BaseTabsFragment) just need to know "the LM has finished
     * positioning the list for the initial scroll".
     *
     * <p>Pass {@code scrollTarget == NO_POSITION} to cancel without
     * firing the callback (or use {@link #cancelInitialPosition()}).
     */
    public void setInitialPosition(int scrollTarget, @Nullable Runnable onReached) {
        mScrollTarget = scrollTarget;
        mOnReached = onReached;
        mWaitingForFirstLayout = scrollTarget != RecyclerView.NO_POSITION;
        if (mWaitingForFirstLayout) {
            scrollToPositionWithOffset(scrollTarget, 0);
        }
    }

    /** Cancel any pending request without firing the callback. */
    public void cancelInitialPosition() {
        mScrollTarget = RecyclerView.NO_POSITION;
        mOnReached = null;
        mWaitingForFirstLayout = false;
    }

    @Override
    public void onLayoutCompleted(RecyclerView.State state) {
        super.onLayoutCompleted(state);
        if (!mWaitingForFirstLayout) return;
        if (state.isPreLayout()) return;

        // The LM has now had its one chance to honor
        // scrollToPositionWithOffset. With predictive animations off
        // there's no second pass that can move us elsewhere, so
        // whatever it produced is the final placement. Release the
        // gate.
        mWaitingForFirstLayout = false;
        Runnable cb = mOnReached;
        mScrollTarget = RecyclerView.NO_POSITION;
        mOnReached = null;
        if (cb != null) cb.run();
    }
}
