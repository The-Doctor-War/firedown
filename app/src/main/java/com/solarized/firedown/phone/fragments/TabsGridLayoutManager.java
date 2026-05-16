package com.solarized.firedown.phone.fragments;

import android.content.Context;

import androidx.annotation.Nullable;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

/**
 * GridLayoutManager that exposes a "scroll to this position on first
 * paint" hook for the initial active-tab placement.
 *
 * <p>Predictive item animations are left enabled (the default). The
 * earlier anchor-drift workaround that disabled them was unblocking
 * the {@code ConcatAdapter(banner, tabs)} setup — banner show/hide
 * forced an insert/remove at adapter position 0 while the LM was
 * mid-layout, and the pre/post-layout anchor recomputation drifted
 * by one row. Now that the banner lives inside the tabs adapter as a
 * view type, banner toggles dispatch through the same diff pipeline
 * as everything else and the two-pass animation runs cleanly.
 *
 * <p><b>Trust-the-first-layout hook.</b>
 * {@code scrollToPositionWithOffset} queued from
 * {@link #setInitialPosition(int, Runnable)} arms a one-shot waiting
 * flag; the very next non-pre {@code onLayoutCompleted} fires the
 * {@code onReached} callback regardless of where the LM ended up
 * placing the row. If the LM has to clamp (target near the end of a
 * short list), clamping still leaves the active row in view, which
 * is the only invariant the caller cares about.
 */
public class TabsGridLayoutManager extends GridLayoutManager {

    private int mScrollTarget = RecyclerView.NO_POSITION;
    @Nullable private Runnable mOnReached;
    private boolean mWaitingForFirstLayout = false;

    public TabsGridLayoutManager(Context context, int spanCount) {
        super(context, spanCount);
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

        // First non-pre-layout pass after the scroll request: whatever
        // the LM produced is the final placement (predictive animations
        // do run a second pass, but it's restricted to running the
        // animator on the already-positioned children — it can't shift
        // the anchor). Release the gate.
        mWaitingForFirstLayout = false;
        Runnable cb = mOnReached;
        mScrollTarget = RecyclerView.NO_POSITION;
        mOnReached = null;
        if (cb != null) cb.run();
    }
}
