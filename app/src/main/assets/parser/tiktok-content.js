// TikTok content script — Take-A-Break dismissal only.
//
// All video capture is handled in background.js, on the wire/document side:
//   * /api/*/item_list/ feeds (FYP, profile, hashtag/challenge, /related/,
//     /newtab/) via a passive webRequest.filterResponseData listener —
//     possible since the geckoview ServiceWorker-visibility patch (0006)
//     makes SW-synthesized responses fire http-on-examine-response. (This
//     replaced the old page-world inject, tiktok-inject.js, now retired.)
//   * SSR-inlined items (single-video /@user/video/<id> detail pages, and
//     the /foryou + "/" feed's FIRST video, which is inlined into the page
//     document and NOT in any item_list XHR) via a main_frame
//     filterResponseData read of the document HTML — reading the raw
//     response bytes is immune to React stripping the rehydration <script>
//     during hydration, the reason we do NOT read it from this DOM (the
//     Threads "read the network response, not the DOM" lesson — see
//     CLAUDE.md).
//
// So this content script is left with ONE job webRequest can't do — DOM
// manipulation:
//   Take-A-Break dismissal — clearing the overlay that visually suppresses
//   /api/* calls. Matters more now that the per-site CanvasRandomization
//   FPP override was removed: the overlay/throttle can re-engage. (Reloading
//   flagged the session and made it worse — dismiss in place only. Don't
//   re-add auto-reload / scroll-nudge / SSR-DOM-scrape workarounds.)
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log(...args); };
    browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
        .then(r => {
            DEBUG = r === true;
            log('[TT] content script loaded ' + location.href);
        }, () => {});

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
