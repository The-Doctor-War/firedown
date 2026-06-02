// Threads media extractor (content script).
//
// Threads runs on Instagram's backend and embeds the same media item shape
// (video_versions / image_versions2 / carousel_media / user.username / code /
// caption) directly in the post page's SSR HTML, inside <script data-sjs>
// Relay-prefetch blobs.
//
// Two earlier approaches failed:
//   1. filterResponseData on the main_frame — GeckoView doesn't deliver a
//      response filter for the top-level document, listener never fired.
//   2. Reading the DOM at document_idle — Meta's bootstrap
//      (ServerJSPayloadListener.process) consumes the data-sjs scripts as soon
//      as they're parsed: the <script> tags remain but their text content is
//      emptied. By document_idle, all 49 scripts had empty bodies.
//      Re-fetching the URL didn't help either: a JS fetch() can't set
//      Sec-Fetch-Dest: document (the headers are forbidden), so the server
//      treated it as a non-navigation request — same emptied shell back.
//
// This approach captures the script bodies during HTML parsing itself.
// run_at: document_start lets us install a MutationObserver before any of the
// page's own scripts run. As the HTML parser inserts each <script data-sjs>,
// the observer's microtask fires (microtasks drain after each parser-step
// "task", so between the data-sjs insertion and the bootstrap <script>
// running). We snapshot textContent at that microtask — by the time bootstrap
// scans for data-sjs scripts to consume, we already have our copy.
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[THREADS-CS]', ...args); };
    browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
        .then(r => { DEBUG = r === true; }, () => {});

    const POST_URL_RE = /threads\.(?:com|net)\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)/;
    function usernameFromUrl(url) { const m = (url || "").match(POST_URL_RE); return m?.[1] || null; }

    function tryParseJson(str) { try { return JSON.parse(str); } catch { return null; } }

    function isMediaItem(obj) {
        if (!obj || typeof obj !== "object") return false;
        if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) return true;
        if (Array.isArray(obj.carousel_media)
            && obj.carousel_media.some(m => Array.isArray(m?.video_versions) && m.video_versions.length > 0)) {
            return true;
        }
        return false;
    }

    function walkMediaItems(node, onItem, depth, seen, counter) {
        // Threads Relay payloads put video_versions at depth ~16-22; a cap of
        // 14 returned before reaching it. See background.js walkThreadsMediaItems.
        if (!node || typeof node !== "object" || depth > 40) return;
        if (counter.visited++ > 50000) return;
        if (seen.has(node)) return;
        seen.add(node);
        if (isMediaItem(node)) onItem(node);
        if (Array.isArray(node)) {
            for (const v of node) walkMediaItems(v, onItem, depth + 1, seen, counter);
        } else {
            for (const k in node) walkMediaItems(node[k], onItem, depth + 1, seen, counter);
        }
    }

    function richness(item) {
        let score = 0;
        if (item?.user?.username) score += 2;
        if (item?.caption?.text) score += 1;
        if (item?.video_duration) score += 1;
        if (item?.image_versions2?.candidates?.length) score += 1;
        if (Array.isArray(item?.carousel_media) && item.carousel_media.length) score += 1;
        return score;
    }

    // Diagnostics so the next failure mode is visible without another round:
    //   - capturedScripts: how many data-sjs script bodies we snapshotted
    //   - emptyBodies: of those, how many were empty (bootstrap-clearing
    //     happens before our snapshot)
    //   - parsedOk: of non-empty, how many parsed as JSON
    //   - withMedia: of parsed, how many contained a media item
    function processCapturedBodies(bodies, pageUrl) {
        let emptyBodies = 0, parsedOk = 0, withMedia = 0;
        const fallbackUser = usernameFromUrl(pageUrl);
        const bestByCode = new Map();
        for (const text of bodies) {
            if (!text) { emptyBodies++; continue; }
            const parsed = tryParseJson(text);
            if (!parsed) continue;
            parsedOk++;
            let foundOne = false;
            walkMediaItems(parsed, (item) => {
                foundOne = true;
                const code = item.code;
                if (!code) return;
                const prev = bestByCode.get(code);
                if (!prev || richness(item) > richness(prev)) bestByCode.set(code, item);
            }, 0, new WeakSet(), { visited: 0 });
            if (foundOne) withMedia++;
        }

        const out = [];
        for (const [code, item] of bestByCode) {
            const username = item.user?.username || fallbackUser || "unknown";
            out.push({ item, origin: `https://www.threads.com/@${username}/post/${code}` });
        }
        log(`captured ${bodies.length} script(s), empty=${emptyBodies} parsed=${parsedOk} withMedia=${withMedia} items=${out.length}`);
        return out;
    }

    // Per-page capture buffer. Reset on SPA navigation so a new post starts
    // with a fresh observer pass.
    let captured = [];
    let observer = null;

    function startCapture() {
        captured = [];
        if (observer) observer.disconnect();
        // documentElement exists at document_start (the html element is
        // created before any of its children are parsed).
        const root = document.documentElement || document;
        observer = new MutationObserver((records) => {
            for (const rec of records) {
                for (const node of rec.addedNodes) {
                    if (node.nodeName !== "SCRIPT") continue;
                    // hasAttribute is safe on Element; nodeName SCRIPT
                    // guarantees we're on HTMLScriptElement.
                    if (!node.hasAttribute || !node.hasAttribute("data-sjs")) continue;
                    // Snapshot the body NOW. Bootstrap may later clear it.
                    const text = node.textContent;
                    if (text) captured.push(text);
                }
            }
        });
        observer.observe(root, { childList: true, subtree: true });
    }

    function finishAndSend(pageUrl) {
        if (observer) { observer.disconnect(); observer = null; }
        const items = processCapturedBodies(captured, pageUrl);
        if (items.length === 0) return;
        browser.runtime.sendMessage({
            type: "threads_intercept",
            payload: { items, url: pageUrl }
        }).catch(() => {});
    }

    // Start capturing immediately at document_start.
    startCapture();

    // Process when the document is fully parsed. DOMContentLoaded fires after
    // all inline scripts (including the bootstrap) have run — we don't care,
    // our snapshots happened during parse.
    let lastUrl = location.href;
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => finishAndSend(lastUrl), { once: true });
    } else {
        // Script injected late (post document_start). Do what we can with the
        // current DOM: bodies are likely empty, but diagnostics will say so.
        Promise.resolve().then(() => finishAndSend(lastUrl));
    }

    // SPA navigation: Threads swaps posts client-side without a new document
    // load, so we won't see fresh data-sjs scripts for the new post (the
    // Relay client fetches via its own GraphQL). For those cases there's
    // nothing more we can capture here — listenerInstagramApiFilter in the
    // background already handles the Instagram-shape XHR responses Threads
    // emits during SPA nav, since they hit the same /api/v1/feed/ paths.
    // We still watch the URL to log so debugging is clear.
    let debounce = null;
    new MutationObserver(() => {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            log("SPA nav detected (no new SSR blobs to capture)", lastUrl);
        }, 300);
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
