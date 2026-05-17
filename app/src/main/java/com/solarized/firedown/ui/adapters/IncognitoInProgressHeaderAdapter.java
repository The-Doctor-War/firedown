package com.solarized.firedown.ui.adapters;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.recyclerview.widget.RecyclerView;

import com.solarized.firedown.R;

/**
 * Single-item adapter that surfaces the "N incognito downloads in
 * progress" hint card at the top of {@code DownloadFragment}'s
 * RecyclerView via {@link androidx.recyclerview.widget.ConcatAdapter}.
 * The card scrolls with the list rather than being pinned, matching
 * the user's expectation that a count-driven informational row
 * behaves like content.
 *
 * <p>Driven by {@code TaskViewModel#getSafeCount} LiveData. Toggle
 * visibility with {@link #setCount(int)} which animates an insert /
 * remove on the underlying RecyclerView via the standard
 * {@code notifyItem*} path.</p>
 */
public class IncognitoInProgressHeaderAdapter
        extends RecyclerView.Adapter<IncognitoInProgressHeaderAdapter.HeaderViewHolder> {

    public interface OnClickListener {
        void onIncognitoBannerClicked();
    }

    private int mCount = 0;
    @Nullable private final OnClickListener mListener;

    public IncognitoInProgressHeaderAdapter(@Nullable OnClickListener listener) {
        mListener = listener;
    }

    /**
     * Update the displayed count. {@code 0} hides the card via
     * {@code notifyItemRemoved(0)}; any positive value either inserts
     * the card (if previously hidden) or refreshes the text in place.
     */
    public void setCount(int count) {
        int prev = mCount;
        mCount = Math.max(0, count);
        if (prev == 0 && mCount > 0) {
            notifyItemInserted(0);
        } else if (prev > 0 && mCount == 0) {
            notifyItemRemoved(0);
        } else if (prev != mCount) {
            notifyItemChanged(0);
        }
    }

    @Override
    public int getItemCount() {
        return mCount > 0 ? 1 : 0;
    }

    @NonNull
    @Override
    public HeaderViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.item_incognito_in_progress_header, parent, false);
        return new HeaderViewHolder(v);
    }

    @Override
    public void onBindViewHolder(@NonNull HeaderViewHolder holder, int position) {
        holder.bind(mCount, mListener);
    }

    static class HeaderViewHolder extends RecyclerView.ViewHolder {

        private final TextView mTitle;

        HeaderViewHolder(@NonNull View itemView) {
            super(itemView);
            mTitle = itemView.findViewById(R.id.incognito_in_progress_title);
        }

        void bind(int count, @Nullable OnClickListener listener) {
            mTitle.setText(itemView.getResources().getQuantityString(
                    R.plurals.incognito_downloads_in_progress_title, count, count));
            if (listener != null) {
                itemView.setOnClickListener(v -> listener.onIncognitoBannerClicked());
            } else {
                itemView.setOnClickListener(null);
            }
        }
    }
}
