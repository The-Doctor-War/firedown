// TikTok content script — DOM-bound capture jobs only.
//
// The feed/grid item_list capture (FYP, profile, hashtag/challenge,
// /related/, /newtab/) is handled in background.js by a passive
// webRequest.filterResponseData listener on /api/*/item_list/. That is
// possible because the geckoview ServiceWorker-visibility patch (0006)
// makes SW-synthesized responses fire http-on-examine-response, so
// filterResponseData now reaches the SW-served feeds that previously
// forced a page-world inject. The old tiktok-inject.js (a fetch/XHR
// hook posting bodies over postMessage) was retired once that path was
// validated on-device (no "Something went wrong" overlay, byte-exact
// pass-through, all feeds captured incl. /newtab/).
//
// What CANNOT move to webRequest, and is why this content script still
// exists:
//   1. captureVideoDetailSSR — single-video /@user/video/<id> pages SSR
//      one item into __UNIVERSAL_DATA_FOR_REHYDRATION__ and fire NO
//      /api/*item_list/ XHR, so there's no network response to tap. We
//      read the blob from the DOM and forward it through the same
//      tiktok-itemlist message the background already handles.
//   2. Take-A-Break dismissal — clearing the overlay is DOM
//      manipulation; webRequest can't touch the page. This matters more
//      now that the per-site CanvasRandomization FPP override was
//      removed: the overlay/throttle can re-engage, and the overlay
//      visually suppresses /api/* calls until dismissed. (Reloading
//      flagged the session and made it worse — dismiss in place only.
//      Don't re-add auto-reload / scroll-nudge workarounds.)
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log(...args); };
    browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
        .then(r => {
            DEBUG = r === true;
            log('[TT] content script loaded ' + location.href);
        }, () => {});

    // Single-video pages (/@user/video/ID) never fire /api/*item_list/ —
    // TikTok hydrates the player directly from the JSON blob in
    // __UNIVERSAL_DATA_FOR_REHYDRATION__ under
    // __DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct.
    // Read that one object and forward it through the same bridge
    // wrapped as a one-item itemList, so the background parser picks
    // it up with no special-casing.
    //
    // Retry across multiple checkpoints because React may strip the
    // rehydration <script> tag during hydration (timing varies by
    // device); whichever checkpoint sees the tag first wins, the rest
    // are no-ops via videoDetailCaptured.
    let videoDetailCaptured = false;
    function captureVideoDetailSSR(label) {
        if (videoDetailCaptured) return;
        try {
            if (!/^\/@[^/]+\/video\/\d+/.test(location.pathname)) {
                log('[TT] video-detail(' + label + '): path no-match ' + location.pathname);
                return;
            }
            const tag = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (!tag || !tag.textContent) {
                log('[TT] video-detail(' + label + '): SSR tag missing');
                return;
            }
            let data;
            try { data = JSON.parse(tag.textContent); }
            catch (e) {
                log('[TT] video-detail(' + label + '): JSON parse failed: '
                    + (e && e.message));
                return;
            }
            const scope = data && data.__DEFAULT_SCOPE__;
            // Both the desktop ("webapp.video-detail") and reflow /
            // mobile ("webapp.reflow.video.detail") variants put a
            // video object under one of these scopes, but at different
            // paths within (itemInfo.itemStruct vs nested deeper).
            // Walk each matching scope structurally for the first
            // object that looks like a video item — has id + video
            // with playAddr/downloadAddr/bitrateInfo.
            function looksLikeVideoItem(o) {
                return o && typeof o === 'object'
                    && typeof o.id === 'string'
                    && o.video && typeof o.video === 'object'
                    && (o.video.playAddr || o.video.downloadAddr
                        || o.video.bitrateInfo);
            }
            function findVideoItem(obj, depth) {
                if (!obj || typeof obj !== 'object' || depth > 8) return null;
                if (looksLikeVideoItem(obj)) return obj;
                if (Array.isArray(obj)) {
                    for (const v of obj) {
                        const f = findVideoItem(v, depth + 1);
                        if (f) return f;
                    }
                } else {
                    for (const k of Object.keys(obj)) {
                        const f = findVideoItem(obj[k], depth + 1);
                        if (f) return f;
                    }
                }
                return null;
            }
            let item = null;
            let itemKey = null;
            if (scope) {
                for (const k of Object.keys(scope)) {
                    if (!/video[-.]detail/i.test(k)) continue;
                    const found = findVideoItem(scope[k], 0);
                    if (found) {
                        item = found;
                        itemKey = k;
                        break;
                    }
                }
            }
            if (!item) {
                const matched = scope
                    ? Object.keys(scope).filter(k => /video[-.]detail/i.test(k))
                    : [];
                const dump = matched
                    .map(k => k + ':{' + (scope[k]
                        ? Object.keys(scope[k]).slice(0, 8).join(',')
                        : 'null') + '}')
                    .join(' | ');
                log('[TT] video-detail(' + label + '): no itemStruct (matched='
                    + (dump || 'none') + ')');
                return;
            }
            videoDetailCaptured = true;
            log('[TT] video-detail SSR captured (' + label + ') id='
                + item.id + ' via ' + itemKey);
            browser.runtime.sendMessage({
                kind: 'tiktok-itemlist',
                url: location.href,
                body: JSON.stringify({ itemList: [item] })
            }).then(() => {}, () => {});
        } catch (e) {
            log('[TT] video-detail(' + label + ') threw: ' + (e && e.message));
        }
    }
    captureVideoDetailSSR('document_start');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded',
            () => captureVideoDetailSSR('DOMContentLoaded'), { once: true });
    }
    window.addEventListener('load', () => captureVideoDetailSSR('load'), { once: true });
    setTimeout(() => captureVideoDetailSSR('timer-500'), 500);
    setTimeout(() => captureVideoDetailSSR('timer-2000'), 2000);

    // Take-A-Break dismiss-in-place. The overlay suppresses /api/*
    // calls until it goes away. Reloading flagged the session and
    // made things worse, so we just close the modal: Escape key first,
    // then a text/aria-label match for the dismiss button.
    let dismissed = false;
    function tryDismissTakeABreak() {
        if (dismissed) return;
        const img = document.querySelector('img[src*="Take_A_Break_Reminder"]');
        if (!img) return;
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                bubbles: true, cancelable: true
            }));
        } catch (_) {}
        const dismissText = /^\s*(keep watching|continue watching|continue|got it!?|ok(ay)?|dismiss|skip|close|i understand|let me watch|watch on)\s*[.!]?\s*$/i;
        let node = img;
        for (let i = 0; i < 14 && node; i++) {
            const candidates = node.querySelectorAll(
                'button, [role="button"], a[role="button"], [aria-label]'
            );
            for (const btn of candidates) {
                const text = (btn.textContent || '').trim();
                const aria = (btn.getAttribute('aria-label') || '').trim();
                if ((text && dismissText.test(text))
                        || (aria && dismissText.test(aria))) {
                    try { btn.click(); } catch (_) {}
                    dismissed = true;
                    log('[TT] Take-A-Break dismissed via "'
                        + (text || aria).slice(0, 40) + '"');
                    return;
                }
            }
            node = node.parentElement;
        }
    }

    // Poll briefly for the overlay (it can mount any time during the
    // first ~6s) and dismiss as soon as it appears.
    const dismissInterval = setInterval(() => {
        tryDismissTakeABreak();
        if (dismissed) clearInterval(dismissInterval);
    }, 400);
    setTimeout(() => clearInterval(dismissInterval), 8000);
})();
