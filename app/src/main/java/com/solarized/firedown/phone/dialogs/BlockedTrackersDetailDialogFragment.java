package com.solarized.firedown.phone.dialogs;

import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.ViewModelProvider;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.solarized.firedown.R;
import com.solarized.firedown.data.models.GeckoStateViewModel;
import com.solarized.firedown.data.models.IncognitoStateViewModel;
import com.solarized.firedown.geckoview.GeckoState;
import com.solarized.firedown.geckoview.TrackingCategory;
import com.solarized.firedown.ui.adapters.BlockedTrackerDetailAdapter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Drill-down sheet listing the actual hosts blocked on the current page,
 * grouped by {@link TrackingCategory}. Opened from the per-page summary
 * row on {@link SecurityStateSheetDialogFragment}; replaces the previous
 * in-line expandable per-category breakdown so we have somewhere to put
 * the long list of domain names without ballooning the parent sheet.
 *
 * <p>Re-uses the parent's data model — {@link GeckoState} already keeps
 * the per-page running counts and per-category host maps. We don't need
 * a new LiveData stream; we observe the existing tracker-counts stream
 * and re-snapshot the host maps on every emission. New blocks while the
 * detail sheet is open will refresh the list automatically.
 *
 * <p>Mode-aware: incognito state lives in a separate repository / view
 * model. The {@code IS_INCOGNITO} arg flag is forwarded by the parent
 * security sheet so this sheet reads from the right side of the wall.
 */
public class BlockedTrackersDetailDialogFragment extends BaseBottomSheetDialogFragment {

    private static final TrackingCategory[] CATEGORY_ORDER = {
            TrackingCategory.CROSS_SITE_COOKIES,
            TrackingCategory.SOCIAL_MEDIA,
            TrackingCategory.FINGERPRINTERS,
            TrackingCategory.CRYPTOMINERS,
            TrackingCategory.TRACKING_CONTENT,
    };

    private GeckoStateViewModel mGeckoStateViewModel;
    private IncognitoStateViewModel mIncognitoStateViewModel;
    private BlockedTrackerDetailAdapter mAdapter;
    private TextView mSubtitle;
    private TextView mEmptyView;
    private RecyclerView mRecyclerView;

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        mGeckoStateViewModel = new ViewModelProvider(mActivity).get(GeckoStateViewModel.class);
        mIncognitoStateViewModel = new ViewModelProvider(mActivity).get(IncognitoStateViewModel.class);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater,
                             @Nullable ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        LayoutInflater themedInflater = container != null
                ? LayoutInflater.from(container.getContext())
                : inflater;
        mView = themedInflater.inflate(R.layout.fragment_dialog_blocked_trackers_detail, container, false);

        mSubtitle = mView.findViewById(R.id.detail_subtitle);
        mEmptyView = mView.findViewById(R.id.detail_empty);
        mRecyclerView = mView.findViewById(R.id.detail_recycler);

        mAdapter = new BlockedTrackerDetailAdapter();
        mRecyclerView.setLayoutManager(new LinearLayoutManager(requireContext()));
        mRecyclerView.setAdapter(mAdapter);
        mRecyclerView.setHasFixedSize(false);

        return mView;
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);

        // Observe the same per-page counts LiveData the parent security
        // sheet uses — when a new tracker is blocked while we're open,
        // we re-snapshot from the GeckoState and rebuild the list.
        LiveData<Map<TrackingCategory, Integer>> counts = mIsIncognito
                ? mIncognitoStateViewModel.getBlockedTrackerCounts()
                : mGeckoStateViewModel.getBlockedTrackerCounts();

        if (mIsIncognito) {
            mIncognitoStateViewModel.refreshBlockedTrackerCounts();
        } else {
            mGeckoStateViewModel.refreshBlockedTrackerCounts();
        }

        counts.observe(getViewLifecycleOwner(), this::rebuildList);
    }


    private void rebuildList(@Nullable Map<TrackingCategory, Integer> countsMap) {
        GeckoState state = mIsIncognito
                ? mIncognitoStateViewModel.peekCurrentGeckoState()
                : mGeckoStateViewModel.peekCurrentGeckoState();

        if (state == null) {
            showEmpty(0);
            return;
        }

        List<Object> items = new ArrayList<>();
        int grandTotal = 0;

        for (TrackingCategory category : CATEGORY_ORDER) {
            Map<String, Integer> hosts = state.getBlockedTrackerHostsSnapshot(category);
            if (hosts.isEmpty()) continue;

            // Per-category total = sum of per-host counts. Falls back to
            // the live counts map when a category's hosts dictionary
            // exists but has been capped (host limit hit) so we still
            // show the accurate total even when not every host is listed.
            int categoryTotal = 0;
            for (Integer v : hosts.values()) {
                if (v != null) categoryTotal += v;
            }
            if (countsMap != null && countsMap.get(category) != null) {
                categoryTotal = Math.max(categoryTotal, countsMap.get(category));
            }
            grandTotal += categoryTotal;

            items.add(new BlockedTrackerDetailAdapter.Header(
                    getString(labelResForCategory(category)),
                    categoryTotal));
            for (Map.Entry<String, Integer> e : hosts.entrySet()) {
                items.add(new BlockedTrackerDetailAdapter.HostRow(e.getKey(), e.getValue()));
            }
        }

        if (items.isEmpty()) {
            showEmpty(grandTotal);
            return;
        }

        mEmptyView.setVisibility(View.GONE);
        mRecyclerView.setVisibility(View.VISIBLE);
        mAdapter.submit(items);

        mSubtitle.setText(getResources().getQuantityString(
                R.plurals.blocked_trackers_summary, grandTotal, grandTotal));
    }


    private void showEmpty(int total) {
        mEmptyView.setVisibility(View.VISIBLE);
        mRecyclerView.setVisibility(View.GONE);
        mSubtitle.setText(getResources().getQuantityString(
                R.plurals.blocked_trackers_summary, total, total));
    }


    private static int labelResForCategory(@NonNull TrackingCategory category) {
        return switch (category) {
            case CROSS_SITE_COOKIES -> R.string.blocked_trackers_cross_site_cookies;
            case SOCIAL_MEDIA -> R.string.blocked_trackers_social_media;
            case FINGERPRINTERS -> R.string.blocked_trackers_fingerprinters;
            case CRYPTOMINERS -> R.string.blocked_trackers_cryptominers;
            default -> R.string.blocked_trackers_tracking_content;
        };
    }
}
