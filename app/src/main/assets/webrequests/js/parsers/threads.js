// Threads parser — split verbatim out of the former parser-background.js.
// Same backend as Instagram; emits through sendInstagramItem (see the section
// comment below for why the parser must own Threads captures).
import { log, tryParseJson, isOwnRequest, cacheTabUrl } from './common.js';
import { sendInstagramItem } from './instagram.js';

// Threads
// ----------------------------------------------------------------------------
// Same backend as Instagram, same item shape (video_versions, image_versions2,
// carousel_media, user.username, code, media_type, caption). We always want
// the video to come from HERE (the parser), not the generic webrequest
// catcher — the catcher would emit a bare .mp4 with no title/author/thumbnail,
// and 'instagram.*\.mp4' is block-listed in webrequests/regex.js precisely so
// the two don't both fire. So the parser is the single source of Threads
// videos, and it must carry the metadata.
//
// The post JSON shows up in one of two places depending on session state:
//
//   1. Logged-in: Threads server-renders the post data inline in the page
//      HTML, inside <script data-sjs> Relay-prefetch blobs. We read it with
//      filterResponseData on the main_frame — the raw network response, immune
//      to the page bootstrap (ServerJSPayloadListener) that consumes those
//      scripts out of the DOM the instant they parse (which is why reading the
//      DOM from a content script, even at document_start, loses the race for
//      the ~200 KB media blob; and why a content-script fetch() can't help —
//      it can't set Sec-Fetch-Dest: document, so the server returns an emptied
//      shell).
//
//   2. Logged-out (the in-app browser's usual state): the document comes back
//      media-less and Threads fetches the post via a GraphQL/API XHR after
//      load. We filter those responses the same way the Instagram and Facebook
//      paths do and run the same media-item walk.
//
// Both paths funnel through emitThreadsItems → sendInstagramItem with a
// threads.com origin override (so the UI groups under the post URL and dedup
// collapses any logged-in overlap between the doc and a follow-up XHR).
// ============================================================================

const THREADS_PAGE_PATTERNS = [
    "*://www.threads.com/@*/post/*",
    "*://www.threads.net/@*/post/*"
];

// Threads (Barcelona) shares Instagram's GraphQL/REST surface. Match the
// GraphQL endpoints plus the v1 REST media/feed routes; the media-item walk
// ignores anything without a video, so over-matching is cheap.
const THREADS_API_PATTERNS = [
    "*://www.threads.com/api/graphql*",
    "*://www.threads.net/api/graphql*",
    "*://www.threads.com/graphql/*",
    "*://www.threads.net/graphql/*",
    "*://www.threads.com/api/v1/*",
    "*://www.threads.net/api/v1/*"
];

function extractThreadsUsernameFromUrl(url) {
    const m = (url || "").match(/threads\.(?:com|net)\/@([A-Za-z0-9._]+)\/post\//);
    return m?.[1] || null;
}

function isThreadsMediaItem(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) return true;
    if (Array.isArray(obj.carousel_media)
        && obj.carousel_media.some(m => Array.isArray(m?.video_versions) && m.video_versions.length > 0)) {
        return true;
    }
    return false;
}

function walkThreadsMediaItems(node, onItem, depth, seen, counter) {
    // Threads Relay payloads nest the media item deep: require[..].__bbox
    // .require[..].__bbox.result.data… puts video_versions at depth ~16-22 in
    // a single-post page. A depth cap of 14 (and a 5000-node budget) returned
    // before reaching it — the doc had the video but the walk never saw it.
    if (!node || typeof node !== "object" || depth > 40) return;
    if (counter.visited++ > 50000) return;
    if (seen.has(node)) return;
    seen.add(node);
    if (isThreadsMediaItem(node)) onItem(node);
    if (Array.isArray(node)) {
        for (const v of node) walkThreadsMediaItems(v, onItem, depth + 1, seen, counter);
    } else {
        for (const k in node) walkThreadsMediaItems(node[k], onItem, depth + 1, seen, counter);
    }
}

// The same item is inlined several times — a canonical record (user + caption +
// duration + thumbnails) and lean Relay fragments carrying only video_versions.
// Keep the richest candidate per code so metadata isn't lost to a lean copy.
function threadsItemRichness(item) {
    let score = 0;
    if (item?.user?.username) score += 2;
    if (item?.caption?.text) score += 1;
    if (item?.video_duration) score += 1;
    if (item?.image_versions2?.candidates?.length) score += 1;
    if (Array.isArray(item?.carousel_media) && item.carousel_media.length) score += 1;
    return score;
}

// Walk one parsed JSON value, folding every video item into bestByCode keyed
// on post code, keeping the richest record per code.
function collectThreadsItems(parsed, bestByCode) {
    walkThreadsMediaItems(parsed, (item) => {
        const code = item.code;
        if (!code) return;
        const prev = bestByCode.get(code);
        if (!prev || threadsItemRichness(item) > threadsItemRichness(prev)) {
            bestByCode.set(code, item);
        }
    }, 0, new WeakSet(), { visited: 0 });
}

// Emit every collected item with full metadata via the shared Instagram
// emitter, under a canonical threads.com post origin.
function emitThreadsItems(details, bestByCode, pageUrl, label) {
    const fallbackUser = extractThreadsUsernameFromUrl(pageUrl || details.url || "");
    log("THREADS", `${label}: ${bestByCode.size} item(s)`, { url: (pageUrl || "").slice(0, 120) });
    for (const [code, item] of bestByCode) {
        const username = item.user?.username || fallbackUser || "unknown";
        sendInstagramItem(details, item, `https://www.threads.com/@${username}/post/${code}`);
    }
}

// Generic streaming-response reader: buffer the body, decode, hand the raw
// string to onBody. Shared by the doc (main_frame HTML) and API (XHR JSON)
// listeners.
function filterThreadsResponse(details, label, onBody) {
    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("THREADS", `${label}: filter create failed`, { error: e.message });
        return;
    }
    const chunks = [];
    filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data); // pass through unmodified
    };
    filter.onstop = () => {
        filter.close();
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        if (total === 0) { log("THREADS", `${label}: 0 bytes`); return; }
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { combined.set(c, offset); offset += c.byteLength; }
        const str = new TextDecoder("utf-8").decode(combined);
        Promise.resolve().then(() => onBody(str, total));
    };
    filter.onerror = () => { try { filter.close(); } catch (_) {} };
}

// (1) Logged-in: read the post JSON inlined in the page HTML's data-sjs blobs.
function listenerThreadsPage(details) {
    if (details.type !== "main_frame") return;
    if (details.tabId >= 0) cacheTabUrl(details.url, details.tabId);
    filterThreadsResponse(details, "doc filter", (html, bytes) => {
        const sjsRegex = /<script[^>]*\bdata-sjs\b[^>]*>([\s\S]*?)<\/script>/g;
        const bestByCode = new Map();
        let scriptCount = 0, m;
        while ((m = sjsRegex.exec(html)) !== null) {
            scriptCount++;
            const parsed = tryParseJson(m[1]);
            if (parsed) collectThreadsItems(parsed, bestByCode);
        }
        log("THREADS", `doc filter: ${bytes} bytes, ${scriptCount} data-sjs script(s)`);
        emitThreadsItems(details, bestByCode, details.url, "doc");
    });
}

// (2) Logged-out: read the post JSON from the GraphQL/API XHR Threads fires
// after the (media-less) document loads.
function listenerThreadsApi(details) {
    if (isOwnRequest(details.url)) return {};
    filterThreadsResponse(details, "api filter", (body, bytes) => {
        let str = body;
        if (str.startsWith("for (;;);")) str = str.slice(9); // anti-hijacking prefix
        const bestByCode = new Map();
        // Threads streams some GraphQL as newline-delimited JSON objects, like
        // Facebook — try whole-body first, then fall back to per-line.
        const whole = tryParseJson(str);
        if (whole) {
            collectThreadsItems(whole, bestByCode);
        } else {
            for (const line of str.split("\n")) {
                const obj = tryParseJson(line);
                if (obj) collectThreadsItems(obj, bestByCode);
            }
        }
        log("THREADS", `api filter: ${bytes} bytes`, { url: details.url.slice(0, 100) });
        const pageUrl = details.documentUrl || details.originUrl || details.url;
        emitThreadsItems(details, bestByCode, pageUrl, "api");
    });
    return {};
}

browser.webRequest.onBeforeRequest.addListener(
    listenerThreadsPage,
    { urls: THREADS_PAGE_PATTERNS, types: ["main_frame"] },
    ["blocking"]
);

browser.webRequest.onBeforeRequest.addListener(
    listenerThreadsApi,
    { urls: THREADS_API_PATTERNS, types: ["xmlhttprequest"] },
    ["blocking"]
);

// Note: Threads needs no content script. The main_frame doc filter
// (listenerThreadsPage) reads the same <script data-sjs> blobs straight from
// the raw network response — stock GeckoView filterResponseData, no patch — and
// the API filter (listenerThreadsApi) covers the logged-out / SPA XHRs. The old
// threads-content.js only re-read the initial-load data-sjs from the DOM (a
// duplicate of the doc filter) and captured nothing on SPA nav, so it was
// removed (CLAUDE.md "prefer one capture mechanism per site").

// ============================================================================
