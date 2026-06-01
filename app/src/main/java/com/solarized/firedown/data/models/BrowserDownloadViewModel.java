package com.solarized.firedown.data.models;

import androidx.annotation.Nullable;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;
import androidx.lifecycle.Transformations;
import androidx.lifecycle.ViewModel;

import com.solarized.firedown.Sorting;
import com.solarized.firedown.data.entity.BrowserDownloadEntity;
import com.solarized.firedown.data.repository.BrowserDownloadRepository;
import com.solarized.firedown.geckoview.GeckoRuntimeHelper;
import com.solarized.firedown.utils.BuildUtils;
import com.solarized.firedown.utils.FileUriHelper;

import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import javax.inject.Inject;

import dagger.hilt.android.lifecycle.HiltViewModel;

@HiltViewModel
public class BrowserDownloadViewModel extends ViewModel {

    private final BrowserDownloadRepository mBrowserDownloadRepository;
    private final GeckoRuntimeHelper mGeckoRuntimeHelper;
    private final Sorting mSorting;
    private final LiveData<List<BrowserDownloadEntity>> mObservableBrowser;
    private final MutableLiveData<Integer> mObservableBrowserType = new MutableLiveData<>();

    @Inject
    public BrowserDownloadViewModel(
            BrowserDownloadRepository repository,
            GeckoRuntimeHelper geckoRuntimeHelper,
            Sorting sorting) {

        this.mBrowserDownloadRepository = repository;
        this.mGeckoRuntimeHelper = geckoRuntimeHelper;
        this.mSorting = sorting;

        // Use Transformations.switchMap to react to limit changes
        mObservableBrowser = Transformations.switchMap(mObservableBrowserType, limit ->
                Transformations.map(mBrowserDownloadRepository.getData(), entities ->
                        filter(entities, limit)
                )
        );
    }

    public LiveData<List<BrowserDownloadEntity>> getBrowserDownloads(int limit) {
        mObservableBrowserType.postValue(limit);
        return mObservableBrowser;
    }

    private List<BrowserDownloadEntity> filter(List<BrowserDownloadEntity> entities, int limit) {
        if (entities == null) return null;

        // Note: Using the injected mGeckoRuntimeHelper instead of static call
        int currentTabId = mGeckoRuntimeHelper.getTabId();

        var stream = entities.stream()
                .filter(entity -> mSorting.getPredicateBrowser(entity) && entity.getTabId() == currentTabId);

        if (limit > 0) {
            stream = stream.limit(limit).sorted(Collections.reverseOrder());
        }

        if (BuildUtils.hasAndroid14()) {
            return stream.toList();
        } else {
            return stream.collect(Collectors.toList());
        }
    }

    /**
     * Count of subtitle entities per video origin, computed from the FULL
     * (unfiltered) repository list — not the chip-filtered adapter list, so
     * the CC badge on a video row stays correct even when the Subtitle chip
     * has filtered the caption siblings out of view. Keyed by origin; only
     * origins with at least one subtitle appear. Restricted to the current
     * tab to match the list the adapter shows.
     */
    public Map<String, Integer> subtitleCountsByOrigin() {
        List<BrowserDownloadEntity> entities = mBrowserDownloadRepository.getData().getValue();
        if (entities == null) return Collections.emptyMap();
        int currentTabId = mGeckoRuntimeHelper.getTabId();
        Map<String, Integer> counts = new HashMap<>();
        for (BrowserDownloadEntity e : entities) {
            if (e == null || e.getTabId() != currentTabId) continue;
            if (!FileUriHelper.isSubtitle(e.getMimeType())) continue;
            String origin = e.getFileOrigin();
            if (origin == null || origin.isEmpty()) continue;
            counts.merge(origin, 1, Integer::sum);
        }
        return counts;
    }

    /**
     * Subtitle entities captured for the given video origin, current tab only.
     * Used by the variant picker to render its captions multi-select section.
     * Returns an empty list if the origin is unknown or has no captions.
     */
    public List<BrowserDownloadEntity> subtitlesForOrigin(@Nullable String origin) {
        if (origin == null || origin.isEmpty()) return Collections.emptyList();
        List<BrowserDownloadEntity> entities = mBrowserDownloadRepository.getData().getValue();
        if (entities == null) return Collections.emptyList();
        int currentTabId = mGeckoRuntimeHelper.getTabId();
        return entities.stream()
                .filter(e -> e != null
                        && e.getTabId() == currentTabId
                        && FileUriHelper.isSubtitle(e.getMimeType())
                        && origin.equals(e.getFileOrigin()))
                .collect(Collectors.toList());
    }

    public int getCurrentSortBrowserId(){
        return mSorting.getCurrentSortBrowserId();
    }

    public String getCurrentSortForIds(int selectedIds){
        return mSorting.getCurrentSortForIds(selectedIds);
    }

    public void setCurrentSortBrowser(int type){
        mSorting.setCurrentSortBrowser(type);
    }

    public void setCurrentSortBrowser(String type){
        mSorting.setCurrentSortBrowser(type);
    }

    public void clearBrowserDownloads() {
        mBrowserDownloadRepository.postClear();
    }

    public void sortBrowserDownloads(String sorting) {
        mSorting.setCurrentSortBrowser(sorting);
        mBrowserDownloadRepository.postComplete();
    }

    public void update() {
        mBrowserDownloadRepository.postComplete();
    }

    public void loadMore(int limit) {
        mObservableBrowserType.postValue(limit);
    }
}