package com.solarized.firedown.ui.adapters;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.solarized.firedown.R;

import java.util.ArrayList;
import java.util.List;

/**
 * Mixed-type adapter for the blocked-trackers detail sheet — alternates
 * between category headers (label + total) and per-host rows (host +
 * per-host block-count). Designed to be rebuilt wholesale on each data
 * refresh: the security sheet's underlying counts churn fast enough that
 * a ListAdapter+DiffUtil dance buys nothing.
 */
public class BlockedTrackerDetailAdapter extends RecyclerView.Adapter<RecyclerView.ViewHolder> {

    private static final int TYPE_HEADER = 0;
    private static final int TYPE_HOST = 1;

    /**
     * Header item — one per category that has at least one blocked host.
     * {@code total} is the sum across all hosts in this category, which
     * may exceed {@code hosts.size()} when a single host fired multiple
     * times.
     */
    public static final class Header {
        public final CharSequence label;
        public final int total;

        public Header(CharSequence label, int total) {
            this.label = label;
            this.total = total;
        }
    }

    /** Per-host row — host string + per-host count. */
    public static final class HostRow {
        public final String host;
        public final int count;

        public HostRow(String host, int count) {
            this.host = host;
            this.count = count;
        }
    }

    private final List<Object> mItems = new ArrayList<>();

    public void submit(@NonNull List<Object> items) {
        mItems.clear();
        mItems.addAll(items);
        notifyDataSetChanged();
    }

    @Override
    public int getItemViewType(int position) {
        return mItems.get(position) instanceof Header ? TYPE_HEADER : TYPE_HOST;
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
        Object item = mItems.get(position);
        if (holder instanceof HeaderViewHolder && item instanceof Header) {
            HeaderViewHolder vh = (HeaderViewHolder) holder;
            Header h = (Header) item;
            vh.label.setText(h.label);
            vh.count.setText(String.valueOf(h.total));
        } else if (holder instanceof HostViewHolder && item instanceof HostRow) {
            HostViewHolder vh = (HostViewHolder) holder;
            HostRow r = (HostRow) item;
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

    @Override
    public int getItemCount() {
        return mItems.size();
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
