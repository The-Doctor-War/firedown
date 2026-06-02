// Threads media extractor (content script).
//
// Threads runs on Instagram's backend and embeds the same media item shape
// (video_versions / image_versions2 / carousel_media / user.username / code /
// caption) directly in the post page's SSR HTML, inside <script data-sjs>
// Relay-prefetch blobs.
//
// We re-fetch the post HTML rather than reading the DOM. By the time a content
// script runs, Meta's bootstrap (ServerJSPayloadListener.process) has already
// consumed the data-sjs scripts: the <script> tags stay in the DOM but their
// text content is emptied, so a DOM read finds the tags and zero payload. A
// same-origin fetch of the post URL returns a fresh server-rendered response
// with the blobs intact. (We can't use filterResponseData on the main_frame
// either — GeckoView doesn't deliver a filter for the top-level document, the
// reason this lives in a content script at all.)
//
// A content script is the right home for the fetch: it carries the page's
// cookies/credentials, is same-origin so no CORS, and is unaffected by the
// page CSP.
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[THREADS-CS]', ...args); };
    browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
        .then(r => { DEBUG = r === true; }, () => {});

    const POST_URL_RE = /threads\.(?:com|net)\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/;
    function isPostUrl(url) { return POST_URL_RE.test(url || ""); }
    function usernameFromUrl(url) { const m = (url || "").match(POST_URL_RE); return m?.[1] || null; }

    function tryParseJson(str) { try { return JSON.parse(str); } catch { return null; } }

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

    // Match any <script data-sjs> regardless of attribute order; non-JSON
    // blobs just fail the parse and are skipped.
    const SJS_RE = /<script[^>]*\bdata-sjs\b[^>]*>([\s\S]*?)<\/script>/g;

    function extractFromHtml(html, pageUrl) {
        const fallbackUser = usernameFromUrl(pageUrl);
        // We do NOT filter by the URL's post code: a Threads post that quotes
        // or reposts another user's video shows that other post's media inline,
        // so the wrapper code in the URL won't match the embedded media's code.
        const bestByCode = new Map();
        let scriptCount = 0;
        let m;
        SJS_RE.lastIndex = 0;
        while ((m = SJS_RE.exec(html)) !== null) {
            scriptCount++;
            const parsed = tryParseJson(m[1]);
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
        log(`scanned ${scriptCount} data-sjs script(s), found ${out.length} item(s)`);
        return out;
    }

    const fetchedUrls = new Set();

    async function scanUrl(url) {
        if (!isPostUrl(url) || fetchedUrls.has(url)) return;
        fetchedUrls.add(url);
        let html;
        try {
            // credentials:include so the SSR response matches the user's
            // logged-in state; Accept:text/html so the server renders the
            // full page rather than a partial/JSON variant.
            const res = await fetch(url, {
                credentials: "include",
                headers: { "Accept": "text/html" }
            });
            html = await res.text();
        } catch (e) {
            fetchedUrls.delete(url); // allow a retry on the next mutation tick
            log("fetch failed", e.message);
            return;
        }
        const items = extractFromHtml(html, url);
        if (items.length === 0) return;
        browser.runtime.sendMessage({
            type: "threads_intercept",
            payload: { items, url }
        }).catch(() => {});
    }

    // Direct load: scan the current URL. Threads is also an SPA — client-side
    // navigation swaps the post without a document load — so watch for URL
    // changes (debounced) and scan each new post URL once.
    function start() {
        scanUrl(location.href);

        let lastUrl = location.href;
        let debounce = null;
        const mo = new MutationObserver(() => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            clearTimeout(debounce);
            debounce = setTimeout(() => scanUrl(location.href), 300);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
        start();
    }
})();
