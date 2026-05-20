package com.solarized.firedown.data.repository;

import androidx.lifecycle.MutableLiveData;

import com.solarized.firedown.utils.WebUtils;

import java.util.HashSet;

/**
 * In-memory WASM allowlist for incognito sessions. Mirrors the
 * persistent {@link WasmAllowlistRepository} but never touches disk —
 * entries are lost when the incognito session ends.
 */
public class IncognitoWasmAllowlistRepository {

    private final HashSet<Integer> mAllowed = new HashSet<>();
    private final MutableLiveData<String> mNeedsWasmEvent = new MutableLiveData<>();

    public void add(String url) {
        mAllowed.add(WebUtils.getDomainName(url).hashCode());
    }

    public void delete(String url) {
        mAllowed.remove(WebUtils.getDomainName(url).hashCode());
    }

    public boolean contains(String url) {
        if (url == null) return false;
        return mAllowed.contains(WebUtils.getDomainName(url).hashCode());
    }

    public void postNeedsWasm(String url) {
        mNeedsWasmEvent.postValue(url);
    }

    public MutableLiveData<String> getNeedsWasmLive() {
        return mNeedsWasmEvent;
    }

    public void clear() {
        mAllowed.clear();
    }
}
