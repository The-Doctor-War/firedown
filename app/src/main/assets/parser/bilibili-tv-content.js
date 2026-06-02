// Bridge for bilibili.tv. The play page SSR-inlines the playurl into
// window.__initialState (no separate playurl XHR fires), so we read it from the
// page world: this content script injects bilibili-tv-inject.js as a
// moz-extension:// <script> (exempt from the page CSP), the inject reads
// window.__initialState.player.playUrl.dash and posts the video+audio DASH
// baseUrls back here, and we forward them to the background. The background
// emits them as video+audio variants → native FFmpegMergeStrategy muxes the two
// whole-track .m4s files (each byte-range-fetched) into one MP4 — no ffmpeg.wasm.
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[BILI-TV-CS]', ...args); };

    function pingDebug() {
        try { window.postMessage({ __firedown_bili__: 2, debug: DEBUG }, '*'); } catch (_) {}
    }
    browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
        .then(r => { DEBUG = r === true; pingDebug(); }, () => {});

    // Inject the page-world reader (re-injectable; appending re-runs it).
    function injectReader() {
        try {
            const s = document.createElement('script');
            s.src = browser.runtime.getURL('bilibili-tv-inject.js');
            s.async = false;
            (document.head || document.documentElement || document).appendChild(s);
            // Re-send the debug flag once the inject is listening.
            setTimeout(pingDebug, 0);
        } catch (e) { log('inject failed', e && e.message); }
    }
    injectReader();

    // Page-world inject → background bridge.
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.__firedown_bili__ !== 1 || !d.payload) return;
        const p = d.payload;
        if (!Array.isArray(p.variants) || p.variants.length === 0) return;
        log('forwarding', p.variants.length, 'variant(s)', p.title);
        browser.runtime.sendMessage({ kind: 'bilibili-tv-streams', payload: p })
            .then(() => {}, () => {});
    });

    // SPA episode navigation swaps the player without a document reload and
    // refreshes window.__initialState. Ask the inject to re-read on URL change
    // (debounced); origin dedup on the background side collapses repeats.
    let lastUrl = location.href;
    let debounce = null;
    new MutationObserver(() => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            try { window.postMessage({ __firedown_bili__: 3 }, '*'); } catch (_) {}
        }, 600);
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
