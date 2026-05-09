package com.solarized.firedown.ui.adapters;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.DiffUtil;
import androidx.recyclerview.widget.ListAdapter;
import androidx.recyclerview.widget.RecyclerView;

import com.solarized.firedown.R;

import java.util.Objects;

/**
 * Mixed-type adapter for the blocked-trackers detail sheet — alternates
 * between category headers (label + total) and per-host rows (host +
 * per-host block-count).
 *
 * <p>Backed by {@link ListAdapter} + {@link DiffUtil} so each
 * counts-LiveData emission only re-binds the rows whose content
 * actually changed. New hosts animate in; existing rows whose count
 * went up rebind cleanly. The detail sheet refires often on
 * tracker-heavy pages (~10/sec while a YouTube ad loads) — without
 * DiffUtil every emission was a notifyDataSetChanged that dropped
 * scroll position transitions and rebuilt every visible row.
 */
public class BlockedTrackerDetailAdapter
        extends ListAdapter<BlockedTrackerDetailAdapter.Item, RecyclerView.ViewHolder> {

    private static final int TYPE_HEADER = 0;
    private static final int TYPE_HOST = 1;

    /** Common base so the adapter's generic parameter is concrete. */
    public abstract static class Item {
        /** Stable key that survives content changes — used by DiffUtil's
         *  areItemsTheSame so a host whose count went from 2 to 3 stays
         *  the same row instead of being treated as a remove + add. */
        abstract String key();
    }

    /**
     * Header item — one per category that has at least one blocked host.
     * {@code total} is the sum across all hosts in this category, which
     * may exceed {@code hosts.size()} when a single host fired multiple
     * times.
     */
    public static final class Header extends Item {
        public final CharSequence label;
        public final int total;

        public Header(CharSequence label, int total) {
            this.label = label;
            this.total = total;
        }

        @Override
        String key() {
            // Headers are unique per category — label is the only thing
            // distinguishing them and never changes mid-session.
            return "h:" + label;
        }
    }

    /** Per-host row — host string + per-host count. */
    public static final class HostRow extends Item {
        public final String host;
        public final int count;

        public HostRow(String host, int count) {
            this.host = host;
            this.count = count;
        }

        @Override
        String key() {
            return "r:" + host;
        }
    }

    private static final DiffUtil.ItemCallback<Item> DIFF = new DiffUtil.ItemCallback<>() {
        @Override
        public boolean areItemsTheSame(@NonNull Item oldItem, @NonNull Item newItem) {
            return oldItem.key().equals(newItem.key());
        }

        @Override
        public boolean areContentsTheSame(@NonNull Item oldItem, @NonNull Item newItem) {
            if (oldItem instanceof Header oh && newItem instanceof Header nh) {
                return oh.total == nh.total && Objects.equals(oh.label, nh.label);
            }
            if (oldItem instanceof HostRow oh && newItem instanceof HostRow nh) {
                return oh.count == nh.count && Objects.equals(oh.host, nh.host);
            }
            return false;
        }
    };

    public BlockedTrackerDetailAdapter() {
        super(DIFF);
    }

    @Override
    public int getItemViewType(int position) {
        return getItem(position) instanceof Header ? TYPE_HEADER : TYPE_HOST;
    }

    @NonNull
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        LayoutInflater inflater = LayoutInflater.from(parent.getContext());
        if (viewType == TYPE_HEADER) {
            return new HeaderViewHolder(inflater.inflate(
                    R.layout.item_blocked_tracker_category_header, parent, false));
        }
        return new HostViewHolder(inflater.inflate(
                R.layout.item_blocked_tracker_host, parent, false));
    }

    @Override
    public void onBindViewHolder(@NonNull RecyclerView.ViewHolder holder, int position) {
        Item item = getItem(position);
        if (holder instanceof HeaderViewHolder vh && item instanceof Header h) {
            vh.label.setText(h.label);
            vh.count.setText(String.valueOf(h.total));
        } else if (holder instanceof HostViewHolder vh && item instanceof HostRow r) {
            vh.host.setText(r.host);
            // ×N suffix only when the same host fired more than once —
            // a single hit reads cleaner without the count.
            if (r.count > 1) {
                vh.count.setVisibility(View.VISIBLE);
                vh.count.setText(vh.itemView.getResources()
                        .getString(R.string.blocked_trackers_host_count_multiplier, r.count));
            } else {
                vh.count.setVisibility(View.GONE);
            }
        }
    }


    static final class HeaderViewHolder extends RecyclerView.ViewHolder {
        final TextView label;
        final TextView count;

        HeaderViewHolder(@NonNull View itemView) {
            super(itemView);
            label = itemView.findViewById(R.id.category_label);
            count = itemView.findViewById(R.id.category_count);
        }
    }

    static final class HostViewHolder extends RecyclerView.ViewHolder {
        final TextView host;
        final TextView count;

        HostViewHolder(@NonNull View itemView) {
            super(itemView);
            host = itemView.findViewById(R.id.host_label);
            count = itemView.findViewById(R.id.host_count);
        }
    }
}
