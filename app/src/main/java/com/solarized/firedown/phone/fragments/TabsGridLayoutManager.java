package com.solarized.firedown.phone.fragments;

import android.content.Context;

import androidx.annotation.Nullable;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

/**
 * GridLayoutManager that exposes a "scroll to this position on first
 * paint, and tell me when it has actually stuck" hook.
 *
 * <p>Background: a plain {@code scrollToPositionWithOffset(...)} sets
 * {@code mPendingScrollPosition} and requests a layout — but during the
 * tabs page's first paint the layout passes triggered by inset
 * dispatch, fragment-postpone release, view attach, etc. can consume or
 * discard that pending scroll before the row actually becomes
 * visible. Captured logs show {@code findFirstVisibleItemPosition()}
 * stuck at 0 for ~100 ms after the call, then jumping to the target —
 * a visible scroll the user reports as a bug.
 *
 * <p>This subclass turns the one-shot pending-scroll into a sticky
 * target: every {@code onLayoutCompleted} re-checks whether the target
 * row is actually the first visible. If not, it re-issues the scroll
 * for the next layout pass. Once {@code findFirstVisibleItemPosition()}
 * matches, the target clears and the {@code onReached} callback fires
 * — that's the cue to release a postponed enter transition.</p>
 *
 * <p>Self-clears on item-count mismatch ({@code state.getItemCount() <=
 * mInitialPosition}) and skips pre-layout passes (where pending scroll
 * is ignored by the superclass anyway).</p>
 */
public class TabsGridLayoutManager extends GridLayoutManager {

    private int mInitialPosition = RecyclerView.NO_POSITION;
    @Nullable private Runnable mOnReached;

    public TabsGridLayoutManager(Context context, int spanCount) {
        super(context, spanCount);
    }

    /**
     * Request that the LayoutManager scroll to {@code position} and keep
     * re-issuing the scroll on every post-layout pass until the row is
     * actually the first visible. Fires {@code onReached} the first time
     * that condition is observed.
     *
     * <p>Calling again with a different position cancels the previous
     * request.</p>
     */
    public void setInitialPosition(int position, @Nullable Runnable onReached) {
        mInitialPosition = position;
        mOnReached = onReached;
        if (position != RecyclerView.NO_POSITION) {
            scrollToPositionWithOffset(position, 0);
        }
    }

    @Override
    public void onLayoutCompleted(RecyclerView.State state) {
        super.onLayoutCompleted(state);
        if (mInitialPosition == RecyclerView.NO_POSITION) return;
        if (state.isPreLayout()) return;

        // If the data set is now too small for the target, give up.
        if (state.getItemCount() <= mInitialPosition) {
            int reached = mInitialPosition;
            Runnable cb = mOnReached;
            mInitialPosition = RecyclerView.NO_POSITION;
            mOnReached = null;
            if (cb != null) cb.run();
            return;
        }

        if (findFirstVisibleItemPosition() == mInitialPosition) {
            Runnable cb = mOnReached;
            mInitialPosition = RecyclerView.NO_POSITION;
            mOnReached = null;
            if (cb != null) cb.run();
        } else {
            // Some intermediate layout pass (postpone release, view
            // attach, …) discarded mPendingScrollPosition. Re-issue it
            // — the next onLayoutCompleted will re-check.
            scrollToPositionWithOffset(mInitialPosition, 0);
        }
    }
}
