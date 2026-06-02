// Threads media extractor (content script).
//
// Threads runs on Instagram's backend and embeds the same media item shape
// (video_versions / image_versions2 / carousel_media / user.username / code /
// caption) directly in the post page's SSR HTML, inside <script data-sjs>
// Relay-prefetch blobs. We read those blobs from the DOM here rather than
// filtering the main_frame response in the background: GeckoView does not
// reliably hand back a response filter for the top-level document, and the
// rest of this extension reads page *content* from a content script (the same
// way TikTok does) while background webRequest listeners only ever touch URLs.
//
// A content script runs in an isolated world but has full read access to the
// page DOM and is unaffected by the page's CSP, so we can read the inline
// scripts without any page-world injection (unlike TikTok, which needs the
// moz-extension inject to observe the page's own fetch traffic).
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[THREADS-CS]', ...args); };
    browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
        .then(r => { DEBUG = r === true; }, () => {});

    function tryParseJson(str) {
        try { return JSON.parse(str); } catch { return null; }
    }

    function usernameFromUrl(url) {
        const m = (url || "").match(/threads\.(?:com|net)\/@([A-Za-z0-9._]+)\/post\//);
        return m?.[1] || null;
    }

    // Is this object an IG-shaped media item with a playable video? Either a
    // single video (video_versions present) or a carousel with >=1 video slide.
    function isMediaItem(obj) {
        if (!obj || typeof obj !== "object") return false;
        if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) return true;
        if (Array.isArray(obj.carousel_media)
            && obj.carousel_media.some(m => Array.isArray(m?.video_versions) && m.video_versions.length > 0)) {
            return true;
        }
        return false;
    }

    // Depth/-node-capped recursive walk over a parsed data-sjs blob. The Relay
    // payloads nest deeply (BBox wrappers, edges, fragments), so bound the work.
    function walkMediaItems(node, onItem, depth, seen, counter) {
        if (!node || typeof node !== "object" || depth > 14) return;
        if (counter.visited++ > 5000) return;
        if (seen.has(node)) return;
        seen.add(node);
        if (isMediaItem(node)) onItem(node);
        if (Array.isArray(node)) {
            for (const v of node) walkMediaItems(v, onItem, depth + 1, seen, counter);
        } else {
            for (const k in node) walkMediaItems(node[k], onItem, depth + 1, seen, counter);
        }
    }

    // The same media item is inlined several times — once as a canonical
    // record (user + caption + duration + thumbnails) and once or more as lean
    // Relay fragments carrying only video_versions. Score by populated fields
    // and keep the richest candidate per code so we don't lose metadata.
    function richness(item) {
        let score = 0;
        if (item?.user?.username) score += 2;
        if (item?.caption?.text) score += 1;
        if (item?.video_duration) score += 1;
        if (item?.image_versions2?.candidates?.length) score += 1;
        if (Array.isArray(item?.carousel_media) && item.carousel_media.length) score += 1;
        return score;
    }

    function extractItems() {
        const fallbackUser = usernameFromUrl(location.href);
        const scripts = document.querySelectorAll('script[type="application/json"][data-sjs]');
        // We do NOT filter by the URL's post code: a Threads post that quotes
        // or reposts another user's video shows that other post's media inline,
        // so the wrapper code in the URL won't match the embedded media's code.
        const bestByCode = new Map();
        for (const s of scripts) {
            const parsed = tryParseJson(s.textContent);
            if (!parsed) continue;
            walkMediaItems(parsed, (item) => {
                const code = item.code;
                if (!code) return;
                const prev = bestByCode.get(code);
                if (!prev || richness(item) > richness(prev)) bestByCode.set(code, item);
            }, 0, new WeakSet(), { visited: 0 });
        }

        const out = [];
        for (const [code, item] of bestByCode) {
            const username = item.user?.username || fallbackUser || "unknown";
            out.push({ item, origin: `https://www.threads.com/@${username}/post/${code}` });
        }
        log(`scanned ${scripts.length} data-sjs script(s), found ${out.length} item(s)`);
        return out;
    }

    function scanAndSend() {
        const items = extractItems();
        if (items.length === 0) return false;
        browser.runtime.sendMessage({
            type: "threads_intercept",
            payload: { items, url: location.href }
        }).catch(() => {});
        return true;
    }

    // The blobs are in the initial SSR HTML, so a single pass at idle catches
    // direct loads. Threads is also an SPA: client-side navigation swaps the
    // post without a fresh document load and injects new data-sjs scripts, so
    // re-scan on URL changes and on DOM growth (debounced), deduped in the
    // background by origin (sendVariants' alreadySent layer).
    function start() {
        scanAndSend();

        let lastUrl = location.href;
        let debounce = null;
        const rescan = () => {
            clearTimeout(debounce);
            debounce = setTimeout(scanAndSend, 400);
        };

        const mo = new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                rescan();
            } else {
                rescan();
            }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();
