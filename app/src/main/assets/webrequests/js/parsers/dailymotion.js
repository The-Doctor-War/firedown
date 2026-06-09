// Dailymotion parser — split verbatim out of the former parser-background.js.
import { log, tryParseJson, isOwnRequest, markOwnRequest, sendVariants, parseHlsMaster, enumerateMasterNative, cacheTabUrl, ensureTabId, registerSpaHandler } from './common.js';

// ============================================================================
// Dailymotion
// ============================================================================

const processedDailymotionUrls = new Set();

/**
 * Parse Dailymotion page URLs.
 * Matches: dailymotion.com/video/{id}, dai.ly/{id}
 */
function parseDailymotionUrl(url) {
    let m = url.match(/dailymotion\.com\/video\/([A-Za-z0-9]+)/);
    if (m) return { videoId: m[1] };

    m = url.match(/dai\.ly\/([A-Za-z0-9]+)/);
    if (m) return { videoId: m[1] };

    return null;
}

/**
 * Intercept geo.dailymotion.com JSON responses to extract stream URLs and metadata.
 * These requests are made by the Dailymotion player to fetch video configuration.
 *
 * URL patterns:
 *   https://geo.dailymotion.com/video/{id}.json?...
 */
function listenerDailymotionGeoApi(details) {
    if (isOwnRequest(details.url)) return {};

    // Extract video ID from the geo API URL
    const match = details.url.match(/\/video\/([A-Za-z0-9]+)\.json/);
    if (!match) return {};

    const videoId = match[1];
    const key = `dm-geo-${videoId}`;
    if (processedDailymotionUrls.has(key)) return {};
    processedDailymotionUrls.add(key);
    setTimeout(() => processedDailymotionUrls.delete(key), 10_000);

    log("DAILYMOTION", `Intercepted geo API request`, { videoId, url: details.url.slice(0, 120) });

    // Use filterResponseData to read the response inline (same pattern as Instagram)
    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("DAILYMOTION", `Failed to create filter`, { error: e.message });
        // Fallback: re-fetch
        fetchDailymotionGeoApi(details, videoId);
        return {};
    }

    const chunks = [];

    filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data);
    };

    filter.onstop = () => {
        filter.close();

        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        if (total === 0) return;

        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }

        const str = new TextDecoder("utf-8").decode(combined);
        const parsed = tryParseJson(str);
        if (!parsed) {
            log("DAILYMOTION", `JSON parse failed`, { firstChars: str.slice(0, 80) });
            return;
        }

        processDailymotionData(details, parsed, videoId);
    };

    filter.onerror = () => {
        filter.close();
        log("DAILYMOTION", `Filter error, falling back to re-fetch`, { videoId });
        processedDailymotionUrls.delete(key);
        fetchDailymotionGeoApi(details, videoId);
    };

    return {};
}

/**
 * Fallback: re-fetch the geo API JSON if filterResponseData is unavailable.
 */
async function fetchDailymotionGeoApi(details, videoId) {
    const key = `dm-fetch-${videoId}`;
    if (processedDailymotionUrls.has(key)) return;
    processedDailymotionUrls.add(key);
    setTimeout(() => processedDailymotionUrls.delete(key), 10_000);

    await ensureTabId(details);
    log("DAILYMOTION", `Fetching geo API`, { videoId });

    try {
        const apiUrl = `https://geo.dailymotion.com/video/${videoId}.json?legacy=true&geo=1`;
        markOwnRequest(apiUrl);
        const resp = await fetch(apiUrl, {
            credentials: "include",
            headers: { "Accept": "application/json" }
        });
        if (!resp.ok) {
            log("DAILYMOTION", `Geo API fetch failed`, { status: resp.status });
            return;
        }

        const data = tryParseJson(await resp.text());
        if (!data) return;

        processDailymotionData(details, data, videoId);
    } catch (e) {
        log("DAILYMOTION", `Geo API fetch error`, e.message);
    }
}

/**
 * Process Dailymotion video JSON data and send to native.
 * The JSON contains qualities.auto[] with HLS URLs, plus metadata.
 */
async function processDailymotionData(details, data, videoId) {
    const origin = `https://www.dailymotion.com/video/${videoId}`;

    // Extract HLS URL from qualities.auto
    let hlsUrl = null;
    if (data.qualities?.auto) {
        for (const entry of data.qualities.auto) {
            if (entry.type === "application/x-mpegURL" && entry.url) {
                hlsUrl = entry.url;
                break;
            }
        }
    }

    if (!hlsUrl) {
        log("DAILYMOTION", `No HLS URL found`, { videoId, qualities: Object.keys(data.qualities || {}) });
        return;
    }

    const title = data.title || "";
    const name = title.length > 40 ? title.slice(0, 40).replace(/\s+\S*$/, "") : title;
    const duration = data.duration ? data.duration * 1000 : 0;

    // Pick best thumbnail
    let img = null;
    if (data.thumbnails) {
        const sizes = ["1080", "720", "480", "360", "240", "180", "120", "60"];
        for (const size of sizes) {
            if (data.thumbnails[size]) { img = data.thumbnails[size]; break; }
        }
    }

    // Headers Dailymotion's manifest/segment CDN (dailymotion.com/cdn/manifest,
    // dmcdn.net) expects — browser UA + Referer. Carried on the emit so they
    // reach every download sub-request (media playlist, segments) via the entity.
    const requestHeaders = [
        { name: "User-Agent", value: navigator.userAgent },
        { name: "Referer", value: "https://www.dailymotion.com/" },
        { name: "Accept", value: "*/*" },
        { name: "Accept-Language", value: "en-US,en;q=0.9" },
    ];

    // Enumerate the HLS master HERE, in the extension, with parseHlsMaster (the JS
    // twin of M3U8Parser) and emit sendVariants(skipProbe) — never the
    // metadatareader probe. We fetch the master in the BROWSER context
    // (credentials:include) because Dailymotion's CDN needs the page's session
    // cookies + UA + Referer; the server-side OkHttp fetch in processHlsMaster
    // gets rejected and falls back to the probe (the "still probed" bug). This is
    // the same shape niconico uses (parse the master in JS, emit variants).
    try {
        markOwnRequest(hlsUrl);
        const resp = await fetch(hlsUrl, { credentials: "include", headers: { "Accept": "*/*" } });
        if (resp.ok) {
            const masterText = await resp.text();
            const variants = parseHlsMaster(masterText, hlsUrl);
            if (variants.length > 0) {
                log("DAILYMOTION", `enumerated ${variants.length} variant(s)`, { videoId, name });
                sendVariants(details, {
                    variants, origin, description: title, name, img, duration,
                    requestHeaders, skipProbe: true, manifest: true
                });
                return;
            }
            log("DAILYMOTION", `master had no STREAM-INF variants`, { videoId, head: masterText.slice(0, 60) });
        } else {
            log("DAILYMOTION", `master fetch failed`, { videoId, status: resp.status });
        }
    } catch (e) {
        log("DAILYMOTION", `master fetch/parse error`, e.message);
    }

    // Fallback: hand the master URL to native enumeration (M3U8Parser, still
    // skipProbe if it can fetch it; only if THAT also fails does it probe).
    log("DAILYMOTION", `falling back to native enumeration`, { videoId });
    enumerateMasterNative(details, { url: hlsUrl, origin, name, description: title, img, duration, requestHeaders });
}

/**
 * Page navigation listener — triggers fetch when user navigates to a Dailymotion video page.
 */
function listenerDailymotionPage(details) {
    if (details.type !== "main_frame") return;
    const parsed = parseDailymotionUrl(details.url);
    if (!parsed) return;

    if (details.tabId >= 0) cacheTabUrl(details.url, details.tabId);

    log("DAILYMOTION", `Page navigation detected`, { videoId: parsed.videoId });
    fetchDailymotionGeoApi(details, parsed.videoId);
}

function checkAndProcessDailymotionUrl(url, tabId) {
    if (!url || !url.includes("dailymotion.com")) return;
    const parsed = parseDailymotionUrl(url);
    if (!parsed) return;

    log("DAILYMOTION", `SPA/tab navigation detected`, { videoId: parsed.videoId, url: url.slice(0, 80), tabId });
    const details = { tabId, url, _resolvedTabId: tabId, requestId: `tab-${tabId}-${Date.now()}` };
    fetchDailymotionGeoApi(details, parsed.videoId);
}

// Intercept geo API responses (filterResponseData to read inline)
browser.webRequest.onBeforeRequest.addListener(
    listenerDailymotionGeoApi,
    { urls: ["*://geo.dailymotion.com/video/*.json*"], types: ["xmlhttprequest"] },
    ["blocking"]
);

// Page navigations (main_frame)
browser.webRequest.onBeforeRequest.addListener(
    listenerDailymotionPage,
    { urls: [
        "*://www.dailymotion.com/video/*",
        "*://dailymotion.com/video/*"
    ], types: ["main_frame"] },
    []
);


// Tab-URL / SPA-navigation trigger (was the hardcoded call in tabs.onUpdated).
registerSpaHandler(checkAndProcessDailymotionUrl);
