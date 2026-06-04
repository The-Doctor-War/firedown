const QUEUE_MAX_LENGTH = 256;
// Flipped from a compile-time constant to a runtime fetch: the Java
// side returns BuildConfig.DEBUG. Defaults to false so release builds
// don't log even if the native query is slow / fails. A handful of
// boot-time log() calls land before the response arrives — that's the
// price of avoiding a synchronous bridge.
let DEBUG = false;
// Two-arg .then (no separate .catch) so the rejection handler is
// already attached when the promise is created. The intermediate
// promise created by a separate .catch can outlive the JS context on
// extension hot-replace and trigger "Promise rejected after context
// unloaded: Actor 'Conduits' destroyed" at the platform level.
browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
    .then(r => { DEBUG = r === true; }, () => {});
const COOKIE_CACHE_KEY = "instagram_cookie_cache";
const COOKIE_CACHE_TTL = 5 * 60 * 1000;

// ============================================================================
// Utilities
// ============================================================================

function log(category, message, data = null) {
    if (!DEBUG) return;
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `[${ts}][${category}]`;
    if (data !== null && data !== undefined) {
        console.log(prefix, message, typeof data === "object" ? JSON.stringify(data) : data);
    } else {
        console.log(prefix, message);
    }
}

function tryParseJson(str) {
    try { return JSON.parse(str); } catch { return null; }
}

// ============================================================================
// Dedup — keyed on origin URL (stable across CDN rotations)
// ============================================================================

const sentOrigins = new Set();
const SENT_ORIGIN_TTL = 30_000;

function alreadySent(origin) { return sentOrigins.has(origin); }

function markSent(origin) {
    sentOrigins.add(origin);
    setTimeout(() => sentOrigins.delete(origin), SENT_ORIGIN_TTL);
}

// ============================================================================
// Own-request tracking — prevents intercepting our own fetches
// ============================================================================

const ownRequests = new Map();
const OWN_REQUEST_TTL = 10_000;

function markOwnRequest(url) {
    ownRequests.set(url, Date.now());
    if (ownRequests.size > 50) {
        const now = Date.now();
        for (const [u, ts] of ownRequests) { if (now - ts > OWN_REQUEST_TTL) ownRequests.delete(u); }
    }
}

function isOwnRequest(url) {
    for (const [ownUrl, ts] of ownRequests) {
        if (Date.now() - ts > OWN_REQUEST_TTL) {
            ownRequests.delete(ownUrl);
            continue;
        }
        if (url === ownUrl || url.startsWith(ownUrl)) {
            ownRequests.delete(ownUrl);
            return true;
        }
    }
    return false;
}

// ============================================================================
// Instagram queue — holds requests waiting for cookies
// ============================================================================

const instagramQueue = new Map();

function addToInstagramQueue(details) {
    const key = details.shortcode;
    if (instagramQueue.has(key)) {
        log("QUEUE", `Already queued: ${key}`);
        return;
    }
    if (instagramQueue.size >= QUEUE_MAX_LENGTH) {
        const firstKey = instagramQueue.keys().next().value;
        instagramQueue.delete(firstKey);
        log("QUEUE", `Queue full, removed oldest: ${firstKey}`);
    }
    instagramQueue.set(key, details);
    log("QUEUE", `Added to queue: ${key}`, { queueSize: instagramQueue.size });
}

// ============================================================================
// Native messaging
// ============================================================================

async function sendNative(message) {
    try {
        // Resolve incognito state from tab if not already set
        if (message.incognito === undefined && message.tabId >= 0) {
            try {
                const tab = await browser.tabs.get(message.tabId);
                message.incognito = tab?.incognito || false;
            } catch (e) {
                message.incognito = false;
            }
        }
        log("NATIVE", `Sending message`, { url: message.url?.slice(0, 100), origin: message.origin, incognito: message.incognito });
        const response = await browser.runtime.sendNativeMessage("parser", message);
        log("NATIVE", `Received response`, response);
        return response;
    } catch (error) {
        log("NATIVE", `Error sending message`, error.message);
        return null;
    }
}

/**
 * Unified variant sender for Twitter, Instagram, and future parsers.
 * Handles dedup, sorting, and message construction.
 */
async function sendVariants(details, { variants, origin, description, img, name, duration, requestHeaders, skipProbe }) {
    if (!Array.isArray(variants) || variants.length === 0) return;

    // Sort by height descending — best quality first
    variants.sort((a, b) => (b.height || 0) - (a.height || 0));

    // Dedup by origin
    if (alreadySent(origin)) {
        log("DEDUP", `Already sent for ${origin}, skipping`);
        return;
    }
    markSent(origin);

    log("VARIANTS", `Sending ${variants.length} variant(s)`, { origin });

    const tabId = await resolveTabId(details);

    // Resolve incognito state from the tab
    let incognito = false;
    if (tabId >= 0) {
        try {
            const tab = await browser.tabs.get(tabId);
            incognito = tab?.incognito || false;
        } catch (e) {}
    }

    const message = {
        url: variants[0].url,
        type: "variants",
        origin,
        tabId,
        request: details.requestId,
        variants,
        incognito
    };

    if (description) message.description = description;
    if (img) message.img = img;
    if (name) message.name = name;
    if (duration > 0) message.duration = duration;
    if (Array.isArray(requestHeaders) && requestHeaders.length > 0) {
        message.requestHeaders = requestHeaders;
    }
    // skipProbe: parser already supplied codecs/duration, so the Java side must
    // not FFprobe (probing an AES-HLS variant burns a single-use key — niconico).
    if (skipProbe) message.skipProbe = true;

    sendNative(message);
}

// ---- Shared HLS master enumeration ----------------------------------------
// Parse a master playlist into quality variants WITHOUT decoding, so a parser
// can populate the quality picker with no capture-time ffprobe. Handles muxed
// renditions (one STREAM-INF = full A/V → single-URL variant, e.g. Twitch/Kick)
// and split audio (EXT-X-MEDIA TYPE=AUDIO referenced via AUDIO="group"),
// resolves relative URLs, and skips I-frame trick-play streams (their tag is
// #EXT-X-I-FRAME-STREAM-INF, which our prefix test ignores). Returns [] if the
// text isn't a master (no STREAM-INF) — callers then fall back to the raw URL.
function resolveUrl(u, base) {
    try { return new URL(u, base).href; } catch (e) { return u; }
}

function parseHlsMaster(text, baseUrl) {
    if (typeof text !== "string" || !text.includes("#EXT-X-STREAM-INF")) return [];
    const lines = text.split(/\r?\n/);
    const audios = {};
    const streams = []; // every STREAM-INF, pre-dedup
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/.test(line)) {
            const gid = (line.match(/GROUP-ID="([^"]+)"/) || [])[1];
            const uri = (line.match(/URI="([^"]+)"/) || [])[1];
            if (gid && uri) audios[gid] = resolveUrl(uri, baseUrl);
            continue;
        }
        if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
        const res = line.match(/RESOLUTION=(\d+)x(\d+)/) || [];
        const audioGroup = (line.match(/AUDIO="([^"]+)"/) || [])[1] || null;
        const codecs = (line.match(/CODECS="([^"]+)"/) || [])[1] || "";
        // BANDWIDTH only — must not match AVERAGE-BANDWIDTH (preceded by '-').
        const bw = parseInt((line.match(/[,:]BANDWIDTH=(\d+)/) || [])[1], 10) || 0;
        // Variant URL = next non-blank, non-tag line.
        let url = null;
        for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (!t) continue;
            if (t.startsWith("#")) break;
            url = t;
            break;
        }
        if (!url) continue;
        streams.push({
            url: resolveUrl(url, baseUrl),
            width: parseInt(res[1], 10) || 0,
            height: parseInt(res[2], 10) || 0,
            audioGroup,
            bw,
            codecs
        });
    }
    if (streams.length === 0) return [];

    // Rank audio groups by the highest bandwidth of the streams referencing them
    // (EXT-X-MEDIA carries no bitrate of its own), best-first.
    const groupMaxBw = {};
    for (const s of streams) {
        if (s.audioGroup && audios[s.audioGroup]) {
            if (groupMaxBw[s.audioGroup] === undefined || s.bw > groupMaxBw[s.audioGroup]) {
                groupMaxBw[s.audioGroup] = s.bw;
            }
        }
    }
    const audioRanked = Object.keys(groupMaxBw)
        .sort((a, b) => groupMaxBw[b] - groupMaxBw[a])
        .map((g) => audios[g]);

    // Dedup videos by URL (keep the highest-bandwidth occurrence), best-first.
    const byUrl = new Map();
    for (const s of streams) {
        const prev = byUrl.get(s.url);
        if (!prev || s.bw > prev.bw) byUrl.set(s.url, s);
    }
    const vids = Array.from(byUrl.values())
        .sort((a, b) => (b.height - a.height) || (b.bw - a.bw));

    // Tier proportionally: map each video's rank to an audio rank so a higher
    // video never gets worse audio than a lower one (monotonic). One audio →
    // every video gets it; no audio groups (muxed master) → single-URL variants.
    const A = audioRanked.length;
    const V = vids.length;
    const variants = [];
    for (let i = 0; i < V; i++) {
        const s = vids[i];
        const v = { url: s.url, width: s.width, height: s.height };
        if (A > 0) {
            const idx = Math.min(A - 1, Math.floor((i * A) / V));
            v.audioUrl = audioRanked[idx];
        }
        if (/\bavc1/.test(s.codecs)) v.videoCodec = "h264";
        else if (/\bhvc1|\bhev1/.test(s.codecs)) v.videoCodec = "hevc";
        if (/\bmp4a/.test(s.codecs)) v.audioCodec = "aac";
        variants.push(v);
    }
    return variants;
}

// Passive response-body text capture (filterResponseData). Returns false if a
// filter couldn't be created. onText receives the body, or null on error.
function filterResponseText(details, onText) {
    let filter;
    try { filter = browser.webRequest.filterResponseData(details.requestId); }
    catch (e) { return false; }
    const chunks = [];
    filter.ondata = (event) => { chunks.push(new Uint8Array(event.data)); filter.write(event.data); };
    filter.onstop = () => {
        filter.close();
        const total = chunks.reduce((a, c) => a + c.byteLength, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
        Promise.resolve().then(() => onText(new TextDecoder("utf-8").decode(buf)));
    };
    filter.onerror = () => { try { filter.close(); } catch (_) {} onText(null); };
    return true;
}

// Emit enumerated HLS variants (no ffprobe) or, on ANY failure, the single media
// URL. For an .m3u8 master we fetch+parse it (unless `body` is supplied). Does
// its own dedup — callers must NOT pre-markSent the origin.
// Hand an HLS master URL to native: Java OkHttp-fetches it (any headers — unlike
// a page fetch() which can't set Origin/Referer) and M3U8Parser enumerates the
// qualities, re-dispatching as variants+skipProbe (or a plain media capture on
// failure). Used for master-only / single-use-key sites (niconico, Kick, Twitch)
// so capture needs no ffmpeg probe and never burns a single-use AES key.
async function enumerateMasterNative(details, { url, origin, name, description, img, duration, requestHeaders }) {
    if (!url) return;
    if (origin && alreadySent(origin)) { log("HLS", "already sent", { origin }); return; }
    if (origin) markSent(origin);

    const tabId = await resolveTabId(details);
    let incognito = false;
    if (tabId >= 0) {
        try { incognito = (await browser.tabs.get(tabId))?.incognito || false; } catch (e) {}
    }

    const message = { type: "hls-master", url, origin, tabId, request: details.requestId, incognito };
    if (name) message.name = name;
    if (description) message.description = description;
    if (img) message.img = img;
    if (duration > 0) message.duration = duration;
    if (Array.isArray(requestHeaders) && requestHeaders.length > 0) message.requestHeaders = requestHeaders;

    log("HLS", `enumerate master via native: ${String(url).slice(0, 90)}`);
    sendNative(message);
}

// An .m3u8 master is enumerated in native (no ffprobe); anything else (a direct
// progressive URL) is emitted as a single media capture.
async function emitHlsMasterOrSingle(details, { url, origin, tabId, name, title, img, duration }) {
    if (/\.m3u8(?:[?#]|$)/.test(url)) {
        enumerateMasterNative(details, { url, origin, name, description: title, img, duration });
        return;
    }
    if (alreadySent(origin)) return;
    markSent(origin);
    sendNative({
        url,
        type: "media",
        origin,
        tabId,
        request: details.requestId,
        name,
        description: title,
        img,
        ...(duration > 0 ? { duration } : {})
    });
}

/**
 * Emits one native message per subtitle track. Each becomes its own
 * BrowserDownloadEntity on the Kotlin side (mime text/vtt or text/srt)
 * and surfaces under the Subtitle filter chip. Sharing `origin` with the
 * parent video keeps them grouped wherever the UI clusters by origin.
 *
 * subtitles: [{ url, language?, label?, format? }]
 */
async function sendSubtitles(details, { subtitles, origin, requestHeaders }) {
    if (!Array.isArray(subtitles) || subtitles.length === 0) return;

    const tabId = await resolveTabId(details);
    let incognito = false;
    if (tabId >= 0) {
        try {
            const tab = await browser.tabs.get(tabId);
            incognito = tab?.incognito || false;
        } catch (e) {}
    }

    for (const sub of subtitles) {
        if (!sub || !sub.url) continue;
        const message = {
            url: sub.url,
            type: "subtitle",
            origin,
            tabId,
            request: details.requestId,
            incognito
        };
        if (sub.language) message.language = sub.language;
        if (sub.label) message.name = sub.label;
        if (Array.isArray(requestHeaders) && requestHeaders.length > 0) {
            message.requestHeaders = requestHeaders;
        }
        sendNative(message);
    }
}

// ============================================================================
// Response filter (for intercepting Instagram API responses)
// ============================================================================

function collectFilteredResponse(details) {
    return new Promise((resolve, reject) => {
        let filter;
        try {
            filter = browser.webRequest.filterResponseData(details.requestId);
        } catch (e) {
            reject(new Error(`Failed to create filter: ${e.message}`));
            return;
        }

        const chunks = [];

        filter.ondata = (event) => {
            chunks.push(event.data);
            filter.write(event.data);
        };

        filter.onstop = () => {
            filter.close();
            const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
            const combined = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(new Uint8Array(chunk), offset);
                offset += chunk.byteLength;
            }
            resolve(new TextDecoder("utf-8").decode(combined));
        };

        filter.onerror = () => {
            // Already in errored state — close() itself throws
            // NS_ERROR_FAILURE on Gecko, which surfaces as a noisy
            // console error even though the rejection is handled.
            try { filter.close(); } catch (_) {}
            reject(new Error(`Filter error: ${filter.error}`));
        };
    });
}

// ============================================================================
// Tab ID resolution
// ============================================================================

const urlToTabCache = new Map();
const URL_TAB_CACHE_TTL = 30_000;

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") {
        cacheTabUrl(tab.url, tabId);
    }
    // Process URLs on navigation start (loading) and completion
    const triggerUrl = changeInfo.url || (changeInfo.status === "complete" ? tab.url : null);
    if (triggerUrl) {
        checkAndProcessInstagramUrl(triggerUrl, tabId);
        checkAndProcessFacebookUrl(triggerUrl, tabId);
        checkAndProcessKickUrl(triggerUrl, tabId);
        checkAndProcessTwitchUrl(triggerUrl, tabId);
        checkAndProcessDailymotionUrl(triggerUrl, tabId);
    }
});

browser.tabs.onRemoved.addListener((tabId) => {
    for (const [url, entry] of urlToTabCache) {
        if (entry.tabId === tabId) urlToTabCache.delete(url);
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [url, entry] of urlToTabCache) {
        if (now - entry.timestamp > URL_TAB_CACHE_TTL) urlToTabCache.delete(url);
    }
}, URL_TAB_CACHE_TTL);

function cacheTabUrl(url, tabId) {
    if (!url) return;
    urlToTabCache.set(url, { tabId, timestamp: Date.now() });
    try {
        const u = new URL(url);
        urlToTabCache.set(u.origin + u.pathname, { tabId, timestamp: Date.now() });
    } catch {}
}

async function resolveTabId(details) {
    if (details.tabId >= 0) return details.tabId;
    if (details._resolvedTabId >= 0) return details._resolvedTabId;

    const urlsToCheck = [details.originUrl, details.url, details.documentUrl].filter(Boolean);

    // Check cache
    for (const url of urlsToCheck) {
        const cached = urlToTabCache.get(url);
        if (cached && Date.now() - cached.timestamp < URL_TAB_CACHE_TTL) {
            details._resolvedTabId = cached.tabId;
            return cached.tabId;
        }
        try {
            const u = new URL(url);
            const base = urlToTabCache.get(u.origin + u.pathname);
            if (base && Date.now() - base.timestamp < URL_TAB_CACHE_TTL) {
                details._resolvedTabId = base.tabId;
                return base.tabId;
            }
        } catch {}
    }

    // Query tabs API
    try {
        // First: for embeds/iframes, match the parent page URL (originUrl/documentUrl)
        // against all open tabs by origin. This avoids misattributing embedded content
        // to a same-domain tab when the embed is on a third-party site.
        const parentUrls = [details.originUrl, details.documentUrl].filter(Boolean);
        if (parentUrls.length > 0) {
            const allTabs = await browser.tabs.query({ currentWindow: true });
            for (const pUrl of parentUrls) {
                try {
                    const pOrigin = new URL(pUrl).origin;
                    // Skip if parent is same domain as the embed (not a cross-site embed)
                    const embedOrigin = details.url ? new URL(details.url).origin : null;
                    if (pOrigin !== embedOrigin) {
                        const match = allTabs.find(t => t.url && t.url.startsWith(pOrigin));
                        if (match) { details._resolvedTabId = match.id; return match.id; }
                    }
                } catch {}
            }
        }

        for (const url of urlsToCheck) {
            const hostname = new URL(url).hostname;
            let pattern;

            if (hostname.includes("instagram.com")) {
                const pathMatch = url.match(/instagram\.com(\/(?:reel|p|stories)\/[^/?#]+)/);
                if (pathMatch) {
                    pattern = `*://*.instagram.com${pathMatch[1]}*`;
                    const tabs = await browser.tabs.query({ url: pattern });
                    if (tabs.length > 0) {
                        const tabId = tabs[0].id;
                        details._resolvedTabId = tabId;
                        cacheTabUrl(url, tabId);
                        return tabId;
                    }
                }
                pattern = "*://*.instagram.com/*";
            } else if (hostname.includes("twitter.com") || hostname.includes("x.com")) {
                pattern = "*://*.x.com/*";
            } else if (hostname.includes("vimeo.com")) {
                pattern = "*://*.vimeo.com/*";
            } else if (hostname.includes("kick.com")) {
                pattern = "*://*.kick.com/*";
            } else if (hostname.includes("twitch.tv")) {
                pattern = "*://*.twitch.tv/*";
            } else if (hostname.includes("dailymotion.com")) {
                pattern = "*://*.dailymotion.com/*";
            } else {
                pattern = `*://${hostname}/*`;
            }

            const tabs = await browser.tabs.query({ url: pattern });
            if (tabs.length > 0) {
                const active = tabs.find(t => t.active);
                const tabId = active ? active.id : tabs[0].id;
                details._resolvedTabId = tabId;
                cacheTabUrl(url, tabId);
                return tabId;
            }
        }

        const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (activeTabs.length > 0) {
            details._resolvedTabId = activeTabs[0].id;
            return activeTabs[0].id;
        }
    } catch (e) {
        log("TABS", `Error resolving tabId`, e.message);
    }

    return -1;
}

async function ensureTabId(details) {
    if (details.tabId < 0) {
        details._resolvedTabId = await resolveTabId(details);
    }
    return details;
}

// ============================================================================
// Vimeo
// ============================================================================

function extractVimeoJsonLd(html) {
    const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        const parsed = tryParseJson(match[1].trim());
        if (parsed) results.push(parsed);
    }
    return results;
}

const processedVimeoUrls = new Set();

async function listenerVimeo(details) {
    if (!details.url.includes("/video/")) return {};

    const urlKey = details.url.split('?')[0];
    if (processedVimeoUrls.has(urlKey)) return {};

    processedVimeoUrls.add(urlKey);
    setTimeout(() => processedVimeoUrls.delete(urlKey), 5000);

    await ensureTabId(details);

    try {
        const response = await fetch(details.url, { credentials: "include" });
        const str = await response.text();

        let config = tryParseJson(str);
        if (!config) {
            const match = str.match(/\b(?:playerC|c)onfig\s*=\s*({.+?})\s*(?:;|\n|<\/script>)/);
            if (match?.[1]) config = tryParseJson(match[1]);
        }

        if (!config?.request?.files?.hls) return {};

        const { hls } = config.request.files;
        const videoUrl = hls.cdns?.[hls.default_cdn]?.avc_url;
        if (!videoUrl) return {};

        const jsonLd = extractVimeoJsonLd(str);
        const tabId = await resolveTabId(details);

        const vid = config.video || {};
        const origin = vid.url || details.originUrl || details.url;

        const message = {
            url: videoUrl,
            type: "media",
            origin,
            tabId,
            request: details.requestId
        };

        // JSON-LD (available when response is HTML, e.g. embedded players)
        if (jsonLd[0]) {
            if (jsonLd[0].name) message.name = jsonLd[0].name;
            if (jsonLd[0].description) message.description = jsonLd[0].description;
            const thumb = jsonLd[0].thumbnailUrl
                || (Array.isArray(jsonLd[0].thumbnail) ? jsonLd[0].thumbnail[0]?.url : jsonLd[0].thumbnail?.url);
            if (thumb) message.img = thumb;
        }

        // config.video fields (always available in JSON config responses)
        if (!message.name && vid.title) message.name = vid.title;
        if (!message.description && vid.owner?.name) message.description = vid.owner.name;
        if (!message.img) {
            message.img = vid.thumbnail_url
                || vid.thumbs?.base || vid.thumbs?.["1280"] || vid.thumbs?.["640"]
                || null;
        }
        if (vid.duration > 0) message.duration = Math.round(vid.duration * 1000);

        log("VIMEO", `Found video`, { name: message.name, img: message.img, url: videoUrl.slice(0, 80), tabId });
        sendNative(message);
    } catch (e) {
        log("VIMEO", `Error`, e.message);
    }

    return {};
}

browser.webRequest.onBeforeRequest.addListener(
    listenerVimeo,
    { urls: ["*://player.vimeo.com/*"], types: ["xmlhttprequest", "sub_frame"] },
    ["blocking"]
);

// ============================================================================
// Apple Podcasts
// ============================================================================
//
// Apple's web player is a React SPA that DOES NOT update the URL when the
// user picks an episode from a show page — pushState doesn't fire, the
// URL stays on the show route, and the audio is fetched directly from
// the publisher's CDN (ivoox, libsyn, megaphone, art19, …).
//
// What DOES fire on show-page load is one amp-api XHR that returns the
// full episode list inline:
//
//   GET https://amp-api.podcasts.apple.com/v1/catalog/{country}/podcasts/{id}
//        ?extend=availableEpisodeCount,editorialArtwork,feedUrl,…
//        &include=artists,episodes,genres,participants,reviews,trailers
//        &limit[episodes]=15
//        &with=entitlements,hlsVideo,showHero
//
// Response shape:
//   { "data": [ {
//       "id": "<podcastId>",
//       "type": "podcasts",
//       "attributes": { "name": "<show name>", "artwork": {...}, ... },
//       "relationships": {
//         "episodes": { "data": [ {
//           "id": "<episodeId>",
//           "type": "podcast-episodes",
//           "attributes": {
//             "name": "...",                   // episode title
//             "description": { "standard": "...", "short": "..." },
//             "assetUrl": "https://.../episode.mp3",   // direct audio URL
//             "artwork": { "url": "https://.../{w}x{h}bb.{f}", ... },
//             "durationInMilliseconds": 234000,
//             "artistName": "...",
//             "url": "https://podcasts.apple.com/.../...?i={episodeId}"
//           }
//         }, ... ] }
//       }
//     } ] }
//
// We filterResponseData on that XHR (same pattern as the Instagram path)
// and surface one media entry per episode. The user then picks which to
// download from the captured-media sheet.
//
// Episode pages reached via direct deep-link (URL contains ?i=<episodeId>)
// are also supported as a fallback — those use the public iTunes Lookup
// API since no amp-api XHR fires on a fresh nav (HTML response on first
// hit, the XHR only fires on the in-app SPA route).

function parseApplePodcastsUrl(url) {
    const m = url.match(/podcasts\.apple\.com\/[^/]+\/podcast\/[^/?#]+\/id(\d+)(?:[?&]i=(\d+))?/);
    if (!m) return null;
    return { podcastId: m[1], episodeId: m[2] || null };
}

function stripHtml(s) {
    if (typeof s !== "string") return "";
    return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Apple's amp-api artwork URLs come with {w}x{h}bb.{f} placeholders
 * (e.g. https://is1-ssl.mzstatic.com/.../{w}x{h}bb.{f}). Pick a 600x600
 * jpeg — matches the artworkUrl600 we'd otherwise pull from iTunes
 * Lookup and is what the native side wants for the thumbnail surface.
 */
function buildAppleArtworkUrl(template) {
    if (typeof template !== "string" || !template) return null;
    return template
        .replace("{w}", "600")
        .replace("{h}", "600")
        .replace("{f}", "jpg");
}

const processedAppleUrls = new Set();

/**
 * Core lookup-and-dispatch path. Takes an Apple episode id plus a source
 * label and origin URL. Called from three triggers (see below) — they
 * differ in how they obtain the episode id but agree on what to do with
 * it. Dedups on the id so the same episode isn't looked up twice when
 * multiple triggers fire within 5 seconds.
 */
async function processApplePodcastEpisode(episodeId, details, originUrl, source) {
    const urlKey = "apple-episode:" + episodeId;
    if (processedAppleUrls.has(urlKey)) return;
    processedAppleUrls.add(urlKey);
    setTimeout(() => processedAppleUrls.delete(urlKey), 5000);

    if (details.requestId !== undefined) {
        await ensureTabId(details);
    }

    try {
        const lookupUrl = `https://itunes.apple.com/lookup?id=${episodeId}&entity=podcastEpisode`;
        markOwnRequest(lookupUrl);
        const response = await fetch(lookupUrl, { credentials: "omit" });
        const data = await response.json();

        if (!data?.results?.length) {
            log("APPLE_PODCAST", `No results for episode ${episodeId}`);
            return;
        }

        // First result may be the podcast (kind=podcast) followed by the
        // episode (kind=podcast-episode) depending on the API's mood;
        // explicitly pick the episode entry.
        const episode = data.results.find(r => r.kind === "podcast-episode")
                    || data.results.find(r => r.wrapperType === "podcastEpisode")
                    || data.results[0];

        if (!episode?.episodeUrl) {
            log("APPLE_PODCAST", `No episodeUrl in lookup result`, { trackId: episode?.trackId });
            return;
        }

        // webNavigation already gives us tabId directly; webRequest needs
        // resolveTabId for cases where the listener fires before the tab
        // url cache has caught up.
        const tabId = details.requestId !== undefined
            ? await resolveTabId(details)
            : details.tabId;

        const message = {
            url: episode.episodeUrl,
            type: "media",
            origin: originUrl,
            tabId,
            name: episode.trackName,
            description: episode.collectionName || stripHtml(episode.description) || undefined,
            img: episode.artworkUrl600 || episode.artworkUrl160 || episode.artworkUrl100,
            duration: typeof episode.trackTimeMillis === "number" ? episode.trackTimeMillis : undefined
        };
        if (details.requestId !== undefined) message.request = details.requestId;

        // Drop undefined fields so the native side sees clean payloads.
        for (const k of Object.keys(message)) {
            if (message[k] === undefined) delete message[k];
        }

        log("APPLE_PODCAST", `Found episode`, {
            name: message.name,
            series: episode.collectionName,
            url: message.url?.slice(0, 100),
            source,
            tabId
        });
        sendNative(message);
    } catch (e) {
        log("APPLE_PODCAST", `Error`, e.message);
    }
}

/**
 * Trigger 1 & 2 — page URL has the episode id in ?i=... Used by
 * webRequest main_frame (initial load / refresh / deep-link) and by
 * webNavigation onHistoryStateUpdated (SPA pushState).
 */
async function processApplePodcastUrl(details, source) {
    const ids = parseApplePodcastsUrl(details.url);
    if (!ids || !ids.episodeId) return;   // show pages have no audio to download
    await processApplePodcastEpisode(ids.episodeId, details, details.url, source);
}

/**
 * Primary trigger — intercept the amp-api show XHR that returns the
 * embedded episode list. We filter the response body in-flight (same
 * filterResponseData pattern Instagram uses), iterate the episodes,
 * and surface each one as a media entry via sendNative. The episode's
 * `attributes.assetUrl` is the direct audio URL on the publisher's
 * CDN — exactly what the native download path needs.
 */
function listenerApplePodcastShow(details) {
    // Only filter the variants that actually include episode data —
    // Apple makes three back-to-back GETs for the same podcast id with
    // different query strings; only one carries include=episodes.
    const url = details.url;
    if (!/[?&]include=[^&]*\bepisodes\b/.test(url)) {
        return {};
    }

    collectFilteredResponse(details).then(text => {
        const json = tryParseJson(text);
        if (!json?.data?.[0]) {
            log("APPLE_PODCAST", `show response has no data`, { url: url.slice(0, 120) });
            return;
        }

        const show = json.data[0];
        const podcastId = show.id;
        const showName = show.attributes?.name;
        const episodes = show.relationships?.episodes?.data || [];

        log("APPLE_PODCAST", `show ${podcastId} has ${episodes.length} embedded episode(s)`, {
            name: showName
        });

        const originUrl = details.documentUrl || details.originUrl || details.url;
        dispatchAppleEpisodes(episodes, showName, originUrl, details, "amp-api/show");
    }).catch(e => {
        log("APPLE_PODCAST", `show filter error`, e.message);
    });

    return {};
}

/**
 * Second trigger — batch episode lookup. When the user presses Play on
 * a show page, the web player fires
 *
 *   GET amp-api.podcasts.apple.com/v1/catalog/{country}/podcast-episodes
 *       ?ids={id1},{id2},...&include=channel,podcast&fields=...,assetUrl,...
 *
 * to fetch the playback queue (clicked episode plus a handful pre-loaded
 * for continuous play). Same JSON:API shape as the show response, just
 * with multiple entries in data[] and the parent podcast inlined via
 * relationships.podcast.data[0].attributes. We filter the response and
 * surface each entry.
 *
 * Note the path is `/podcast-episodes` (no trailing /{id}) — Apple
 * batches by ids in the query string rather than path. My earlier
 * /podcast-episodes/{id} match pattern was a phantom and never fired.
 */
function listenerApplePodcastEpisodesBatch(details) {
    collectFilteredResponse(details).then(text => {
        const json = tryParseJson(text);
        if (!Array.isArray(json?.data)) {
            log("APPLE_PODCAST", `episodes-batch response has no data array`, {
                url: details.url.slice(0, 120)
            });
            return;
        }

        log("APPLE_PODCAST", `episodes-batch returned ${json.data.length} episode(s)`);

        const originUrl = details.documentUrl || details.originUrl || details.url;
        // Show name is on the first episode's relationships.podcast.data[0]
        // (it's the same parent podcast for every entry in a single batch).
        const podcastRel = json.data[0]?.relationships?.podcast?.data?.[0];
        const showName = podcastRel?.attributes?.name;

        dispatchAppleEpisodes(json.data, showName, originUrl, details, "amp-api/episodes-batch");
    }).catch(e => {
        log("APPLE_PODCAST", `episodes-batch filter error`, e.message);
    });

    return {};
}

/**
 * Shared episode dispatcher. Takes a JSON:API episodes array, the parent
 * show name (used as the description field), the URL the user is browsing
 * (used as origin), and the original webRequest details (for tabId +
 * requestId). Builds one media message per episode and sends each through
 * sendNative. Dedups on episodeId across both triggers so the user doesn't
 * see the same episode twice when both the show response and the batch
 * fire for it.
 */
function dispatchAppleEpisodes(episodes, showName, originUrl, details, source) {
    for (const episode of episodes) {
        const ep = episode?.attributes;
        if (!ep?.assetUrl) continue;

        const episodeId = episode.id;
        const dedupKey = "apple-episode:" + episodeId;
        if (processedAppleUrls.has(dedupKey)) continue;
        processedAppleUrls.add(dedupKey);
        setTimeout(() => processedAppleUrls.delete(dedupKey), 30000);

        // Each batch entry may also have its own relationships.podcast.data
        // (the batch listener relies on this). Prefer the per-entry name
        // when the caller didn't pass one in.
        const episodeShowName = showName
            || episode.relationships?.podcast?.data?.[0]?.attributes?.name
            || ep.artistName;

        const message = {
            url: ep.assetUrl,
            type: "media",
            origin: ep.url || originUrl,
            tabId: details.tabId,
            request: details.requestId,
            name: ep.name,
            description: episodeShowName,
            img: buildAppleArtworkUrl(ep.artwork?.url),
            duration: typeof ep.durationInMilliseconds === "number"
                ? ep.durationInMilliseconds
                : undefined
        };
        for (const k of Object.keys(message)) {
            if (message[k] === undefined) delete message[k];
        }

        log("APPLE_PODCAST", `Found episode`, {
            name: message.name,
            series: episodeShowName,
            url: message.url?.slice(0, 100),
            source
        });
        sendNative(message);
    }
}

/**
 * Fallback trigger — direct deep-link / refresh into an episode page
 * URL (the kind that contains ?i={episodeId}). The amp-api show XHR
 * above doesn't always fire in this path because the SPA may be hydrated
 * directly into episode view, so we also keep an iTunes Lookup fallback
 * driven by main_frame + pushState events on /podcast/ URLs.
 */
async function listenerApplePodcasts(details) {
    await processApplePodcastUrl(details, "webRequest");
    return {};
}

browser.webRequest.onBeforeRequest.addListener(
    listenerApplePodcastShow,
    {
        urls: [
            "*://amp-api.podcasts.apple.com/v1/catalog/*/podcasts/*",
            "*://amp-api-edge.podcasts.apple.com/v1/catalog/*/podcasts/*"
        ],
        types: ["xmlhttprequest"]
    },
    ["blocking"]
);

browser.webRequest.onBeforeRequest.addListener(
    listenerApplePodcastEpisodesBatch,
    {
        urls: [
            "*://amp-api.podcasts.apple.com/v1/catalog/*/podcast-episodes*",
            "*://amp-api-edge.podcasts.apple.com/v1/catalog/*/podcast-episodes*"
        ],
        types: ["xmlhttprequest"]
    },
    ["blocking"]
);

browser.webRequest.onBeforeRequest.addListener(
    listenerApplePodcasts,
    {
        urls: ["*://podcasts.apple.com/*/podcast/*"],
        types: ["main_frame"]
    },
    []
);

browser.webNavigation.onHistoryStateUpdated.addListener(
    (details) => {
        if (details.frameId !== 0) return;
        processApplePodcastUrl(details, "webNavigation");
    },
    {
        url: [{ hostEquals: "podcasts.apple.com", pathContains: "/podcast/" }]
    }
);

// ============================================================================
// TikTok
// ============================================================================

// Strip ?refer=embed from TikTok profile/video URLs before the page
// loads. With refer=embed present, TikTok's frontend renders the
// embed-preview layout and skips /api/post/item_list/ entirely — only
// /api/preload/item_list/ (FYP cold-start) fires, so the profile
// owner's actual posts never become visible to the capture hook.
// Removing the query param makes TikTok render the full profile and
// triggers the normal post-grid fetch.
browser.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.type !== "main_frame") return {};
        try {
            const u = new URL(details.url);
            if (!u.hostname.endsWith("tiktok.com")) return {};
            if (!u.searchParams.has("refer")) return {};
            const refer = u.searchParams.get("refer");
            if (refer !== "embed" && refer !== "embeded") return {};
            u.searchParams.delete("refer");
            const clean = u.toString();
            log("TIKTOK", "stripping refer=embed", { from: details.url.slice(0, 100), to: clean.slice(0, 100) });
            return { redirectUrl: clean };
        } catch (_) {
            return {};
        }
    },
    { urls: ["*://www.tiktok.com/*", "*://m.tiktok.com/*"], types: ["main_frame"] },
    ["blocking"]
);

// Build the header set that lets v*-webapp-prime.tiktok.com /video/
// URLs replay successfully from the native downloader. Mirrors what
// Firefox itself sends on the page-driven media fetch (captured via
// the webrequests path): Origin/Referer/Sec-Fetch-* and — crucially
// — Cookie, which carries tt_chain_token (the URL's `tk=` param names
// this cookie as the auth source, so without it TikTok 403s).
async function buildTikTokHeaders() {
    let cookieHeader = "";
    let cookieCount = 0;
    try {
        const cookies = await browser.cookies.getAll({ domain: "tiktok.com" });
        cookieCount = cookies.length;
        cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join("; ");
    } catch (e) {
        log("TIKTOK", `cookies.getAll failed`, e.message);
    }
    log("TIKTOK", `built headers`, { cookies: cookieCount, cookieLen: cookieHeader.length, ua: navigator.userAgent.slice(0, 60) });
    return [
        { name: "User-Agent",     value: navigator.userAgent },
        { name: "Accept",         value: "*/*" },
        { name: "Accept-Language", value: "en-US,en;q=0.9" },
        { name: "Origin",         value: "https://www.tiktok.com" },
        { name: "Referer",        value: "https://www.tiktok.com/" },
        { name: "Sec-Fetch-Dest", value: "empty" },
        { name: "Sec-Fetch-Mode", value: "cors" },
        { name: "Sec-Fetch-Site", value: "same-site" },
        { name: "Connection",     value: "keep-alive" },
        { name: "Cookie",         value: cookieHeader }
    ];
}

// Receives JSON bodies posted by the content-script bridge. The body
// is the exact response the page itself received via fetch/XHR —
// captured by a page-world hook (tiktok-inject.js) that observes
// passively without touching the network stack. This avoids three
// failure modes encountered with webRequest-based approaches:
//   1. filterResponseData perturbs the page (TikTok shows a
//      "something went wrong" overlay).
//   2. Refetching the URL ourselves trips TikTok's single-use
//      msToken / X-Bogus signature and returns a stripped response.
//   3. ServiceWorker-served endpoints (/related/item_list/) can't be
//      tapped via filterResponseData at all.
async function handleTikTokItemList(msg, sender) {
    // Empty body slips through if a future inject revision stops
    // filtering them out; treat it as the no-op preflight it is
    // without logging "parse failed" (misleading: there's nothing to
    // parse, not a malformed JSON).
    if (!msg.body) return;

    log("TIKTOK", `onMessage`, {
        url: (msg.url || "").slice(0, 120),
        bodyLen: msg.body.length,
        tabId: sender.tab?.id ?? -1,
        tabUrl: (sender.tab?.url || "").slice(0, 80)
    });

    const json = tryParseJson(msg.body);
    if (!json) {
        log("TIKTOK", `JSON parse failed`, { head: msg.body.slice(0, 200) });
        return;
    }

    // /api/preload/item_list/ and the various /api/*/item_list/
    // endpoints don't share a single response shape. Try the common
    // keys first, then fall back to a deep-walk for the first
    // video-bearing array.
    let items = null;
    let itemsSource = null;
    const candidates = [
        ['itemList', json.itemList],
        ['aweme_list', json.aweme_list],
        ['data.itemList', json?.data?.itemList],
        ['data.aweme_list', json?.data?.aweme_list],
        ['itemListResponse.itemList', json?.itemListResponse?.itemList],
        ['videos', json.videos],
    ];
    for (const [src, val] of candidates) {
        if (Array.isArray(val) && val.length > 0) {
            items = val;
            itemsSource = src;
            break;
        }
    }
    if (!items) {
        // Deep-walk: pick the first array whose first element looks
        // like a TikTok video item.
        const seen = new WeakSet();
        const walk = (obj, depth, path) => {
            if (items || !obj || typeof obj !== 'object' || depth > 6) return;
            if (seen.has(obj)) return;
            seen.add(obj);
            if (Array.isArray(obj)) {
                const first = obj[0];
                if (first && typeof first === 'object' && first.video
                        && (first.video.playAddr || first.video.downloadAddr
                            || first.video.bitrateInfo)) {
                    items = obj;
                    itemsSource = 'deep:' + path;
                    return;
                }
                for (let i = 0; i < obj.length && !items; i++) {
                    walk(obj[i], depth + 1, path + '[' + i + ']');
                }
            } else {
                for (const k of Object.keys(obj)) {
                    if (items) break;
                    walk(obj[k], depth + 1, path + '.' + k);
                }
            }
        };
        walk(json, 0, '$');
    }

    if (!Array.isArray(items)) {
        log("TIKTOK", `no itemList[] in body`, { topKeys: Object.keys(json).slice(0, 12), bodyLen: msg.body.length });
        return;
    }
    if (items.length === 0) {
        log("TIKTOK", `empty itemList[]`, { source: itemsSource });
        return;
    }
    log("TIKTOK", "items found", { count: items.length, source: itemsSource, firstId: items[0] && items[0].id });

    const pathname = (() => {
        try { return new URL(msg.url, sender.tab?.url || "https://www.tiktok.com/").pathname; }
        catch (_) { return msg.url; }
    })();
    log("TIKTOK", `${items.length} item(s) from ${pathname}`);

    const headers = await buildTikTokHeaders();
    const tabId = sender.tab?.id ?? -1;
    const pageUrl = sender.tab?.url || "https://www.tiktok.com/";

    let sentCount = 0;
    let skippedNoVariants = 0;
    let skippedNoVideo = 0;
    for (const item of items) {
        const v = item?.video;
        if (!v) { skippedNoVideo++; continue; }

        const author = item.author?.uniqueId || item.author?.nickname;
        const caption = (item.desc || "").split("\n")[0].slice(0, 140);
        const canonical = author && item.id
            ? `https://www.tiktok.com/@${author}/video/${item.id}`
            : pageUrl;

        const variants = [];
        if (Array.isArray(v.bitrateInfo)) {
            for (const b of v.bitrateInfo) {
                const list = b?.PlayAddr?.UrlList;
                if (!Array.isArray(list) || list.length === 0) continue;
                variants.push({
                    url: list[0],
                    width: b.PlayAddr?.Width || v.width || 0,
                    height: b.PlayAddr?.Height || v.height || 0,
                    videoCodec: "h264"
                });
            }
        }
        if (variants.length === 0 && (v.playAddr || v.downloadAddr)) {
            variants.push({
                url: v.playAddr || v.downloadAddr,
                width: v.width || 0,
                height: v.height || 0,
                videoCodec: "h264"
            });
        }
        if (variants.length === 0) { skippedNoVariants++; continue; }

        log("TIKTOK", `item -> sendVariants`, {
            id: item.id,
            author,
            variants: variants.length,
            topUrl: variants[0].url.slice(0, 80),
            name: caption.slice(0, 60)
        });

        // Synthetic details object: sendVariants only reads tabId,
        // requestId, documentUrl, originUrl, and url.
        const details = {
            tabId,
            documentUrl: pageUrl,
            originUrl: pageUrl,
            url: msg.url,
            requestId: `tiktok-${item.id || Date.now()}`
        };

        sendVariants(details, {
            variants,
            origin: canonical,
            description: author ? "@" + author : undefined,
            img: v.cover || v.originCover,
            name: caption || (author ? `TikTok by @${author}` : "TikTok video"),
            duration: typeof v.duration === "number" ? v.duration * 1000 : 0,
            requestHeaders: headers
        });
        sentCount++;
    }
    log("TIKTOK", `batch done`, { sent: sentCount, skippedNoVideo, skippedNoVariants, total: items.length });
}

browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.kind !== "tiktok-itemlist") return;
    handleTikTokItemList(msg, sender).catch(e => {
        log("TIKTOK", `handler error`, e.message);
    });
});

// ============================================================================
// Twitter / X
// ============================================================================

// GraphQL queries that resolve to a single focal tweet (open-tweet view /
// embed). Parsed via extractTwitterFocalResult so we grab only the tweet the
// user is looking at, not replies in the thread.
const TWITTER_TWEET_QUERIES = ["TweetResultByRestId", "TweetDetail"];
// Timeline queries — feeds / profiles / search / lists / bookmarks / likes.
// These carry many tweets; we emit every video tweet in them so scrolling a
// feed surfaces its videos without opening each one.
const TWITTER_TIMELINE_QUERIES = [
    "HomeTimeline", "HomeLatestTimeline",
    "UserTweets", "UserTweetsAndReplies", "UserMedia",
    "SearchTimeline", "ListLatestTweetsTimeline",
    "Bookmarks", "Likes", "TweetActivity", "CommunityTweetsTimeline",
    "ImmersiveMedia"
];

function twitterQueryKind(url) {
    if (TWITTER_TWEET_QUERIES.some(q => url.includes(q))) return "tweet";
    if (TWITTER_TIMELINE_QUERIES.some(q => url.includes(q))) return "timeline";
    return null;
}

function extractScreenNameFromUrl(details) {
    const urls = [details.originUrl, details.url, details.documentUrl].filter(Boolean);
    for (const url of urls) {
        const match = url.match(/x\.com\/([A-Za-z0-9_]+)\/status\//);
        if (match?.[1] && match[1] !== "i") return match[1];
    }
    for (const [url] of urlToTabCache) {
        const match = url.match(/x\.com\/([A-Za-z0-9_]+)\/status\//);
        if (match?.[1] && match[1] !== "i") return match[1];
    }
    return null;
}

// Unwrap a tweet_results.result that may be a TweetWithVisibilityResults
// wrapper (its real tweet lives under .tweet) or a raw Tweet.
function unwrapTweet(result) {
    return result?.tweet || result;
}

// Collect EVERY tweet_results.result reachable in a GraphQL response — works
// across all the timeline/conversation shapes (TweetDetail's
// threaded_conversation_with_injections_v2, HomeTimeline's
// home.home_timeline_urt, UserTweets' user.result.timeline_v2, search, etc.)
// by recursively scanning for the tweet_results.result key rather than hard-
// coding each instruction path. Deduped by rest_id.
function collectTweetResults(node, out, seen) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const v of node) collectTweetResults(v, out, seen);
        return;
    }
    const r = node.tweet_results && node.tweet_results.result;
    if (r) {
        const t = unwrapTweet(r);
        const id = t?.rest_id || t?.legacy?.id_str;
        if (id && !seen.has(id)) { seen.add(id); out.push(r); }
    }
    for (const k in node) {
        // tweet_results handled above; recurse the rest.
        if (k === "tweet_results") continue;
        collectTweetResults(node[k], out, seen);
    }
}

// Pick the single focal tweet for TweetResultByRestId / TweetDetail. Prefers
// the focalTweetId from the request variables so a reply's video in the thread
// isn't grabbed instead of the tweet the user opened.
function extractTwitterFocalResult(parsed, details) {
    const direct = parsed.data?.tweetResult?.result || parsed.data?.tweet?.result;
    if (direct) return direct;

    let focalTweetId = null;
    try {
        const m = details.url.match(/[?&]variables=([^&]+)/);
        if (m) focalTweetId = JSON.parse(decodeURIComponent(m[1])).focalTweetId || null;
    } catch (e) { /* malformed variables — fall through to heuristics */ }

    const candidates = [];
    collectTweetResults(parsed.data, candidates, new Set());
    if (candidates.length === 0) return null;

    if (focalTweetId) {
        const focal = candidates.find(r => {
            const t = unwrapTweet(r);
            return (t?.rest_id || t?.legacy?.id_str) === focalTweetId;
        });
        if (focal) return focal;
    }
    // No focalTweetId match: prefer the first candidate that actually has video.
    const withVideo = candidates.find(r => {
        const t = unwrapTweet(r);
        return t?.legacy?.extended_entities?.media?.some(med => med.video_info?.variants);
    });
    return withVideo || candidates[0];
}

// Scan a Twitter media object for subtitle / closed-caption track URLs.
// Twitter doesn't expose these consistently — modern uploaded videos often
// burn captions into the pixels, and auto-generated captions load via a
// separate player request that the generic webrequest interceptor catches
// passively when the user plays the video. This scanner picks up the cases
// where the GraphQL response DOES include track metadata, so the captions
// are discoverable even if the user never hits play.
//
// Known/observed locations (defensive — none are guaranteed):
//   m.video_info.subtitles[]
//   m.closed_captions[]
//   m.additional_media_info.subtitles[]
// Entry shape is normalised to { url, language, label }.
function extractTwitterSubtitles(m) {
    const candidates = [];
    const push = (arr) => { if (Array.isArray(arr)) candidates.push(...arr); };
    push(m?.video_info?.subtitles);
    push(m?.closed_captions);
    push(m?.additional_media_info?.subtitles);

    const out = [];
    for (const c of candidates) {
        if (!c) continue;
        const url = c.url || c.uri || c.src || c.captions_url;
        if (!url || !/^https?:/i.test(url)) continue;
        const language = c.language || c.lang || c.locale || c.bcp47 || null;
        const label = c.display_name || c.label || c.name || null;
        out.push({ url, language, label });
    }
    return out;
}

// Turn one tweet_results.result into download variants and send them.
// Returns true if at least one video was emitted.
function emitTwitterTweetVideos(details, result) {
    const tweetResult = unwrapTweet(result);
    const legacy = tweetResult?.legacy;
    const media = legacy?.extended_entities?.media;
    if (!media || media.length === 0) return false;

    // X migrated User fields (screen_name, name) out of `legacy` into a new
    // `core` sub-object on the user result; older responses still carry them
    // in `legacy`. Reading only `legacy.screen_name` made every timeline
    // video resolve to "unknown" (the home/feed view has no /status/ URL for
    // extractScreenNameFromUrl to fall back on). Check the new `core`
    // location first, then `legacy`. NB: user.core (the user's handle/name)
    // is a different object from tweet.core (which holds user_results).
    const userResult = tweetResult.core?.user_results?.result
        || result.core?.user_results?.result;
    const screenName = userResult?.core?.screen_name
        || userResult?.legacy?.screen_name
        || extractScreenNameFromUrl(details)
        || "unknown";
    const tweetId = tweetResult.rest_id || legacy.id_str;
    const originUrl = screenName !== "unknown"
        ? `https://x.com/${screenName}/status/${tweetId}`
        : `https://x.com/i/status/${tweetId}`;
    const videoText = legacy.full_text || "";

    let imageUrl = media[0]?.media_url_https;
    if (!imageUrl) {
        const bindings = tweetResult.card?.legacy?.binding_values;
        const keys = ["thumbnail_image_original", "player_image_large", "player_image",
                      "summary_photo_image_original", "thumbnail_image"];
        for (const key of keys) {
            const url = bindings?.find(b => b.key === key)?.value?.image_value?.url;
            if (url) { imageUrl = url; break; }
        }
    }

    let emitted = false;
    for (const m of media) {
        if (!m.video_info?.variants) continue;
        const variants = m.video_info.variants
            .filter(v => v.content_type === "video/mp4")
            .map(v => {
                const wh = v.url.match(/\/(\d+)x(\d+)\//);
                return { url: v.url, width: wh ? parseInt(wh[1]) : 0, height: wh ? parseInt(wh[2]) : 0 };
            });
        if (variants.length === 0) continue;
        emitted = true;
        sendVariants(details, {
            variants,
            origin: originUrl,
            description: videoText,
            img: imageUrl,
            name: screenName,
            duration: m.video_info.duration_millis || 0
        });

        const subtitles = extractTwitterSubtitles(m);
        if (subtitles.length > 0) {
            log("TWITTER", `found ${subtitles.length} subtitle track(s)`, { origin: originUrl });
            sendSubtitles(details, { subtitles, origin: originUrl });
        }
    }
    return emitted;
}

// Process one already-parsed GraphQL response, branching on query kind.
function processTwitterResponse(details, kind, parsed) {
    if (kind === "timeline") {
        // Feed / profile / search: emit every video tweet in the timeline.
        const results = [];
        collectTweetResults(parsed.data, results, new Set());
        let withVideo = 0;
        for (const r of results) {
            if (emitTwitterTweetVideos(details, r)) withVideo++;
        }
        log("TWITTER", `timeline: ${withVideo}/${results.length} tweet(s) with video`);
        return;
    }
    // Single-tweet view (TweetResultByRestId / TweetDetail).
    const rawResult = extractTwitterFocalResult(parsed, details);
    if (!rawResult) {
        log("TWITTER", "no focal result", {
            topKeys: Object.keys(parsed.data || {}),
            errors: parsed.errors ? parsed.errors.map(e => e.message) : null
        });
        return;
    }
    const ok = emitTwitterTweetVideos(details, rawResult);
    log("TWITTER", ok ? "focal: video emitted" : "focal: no video in tweet");
}

// Logged-out / embeds use api.x.com/graphql/; signed-in TweetDetail and the
// timelines use x.com/i/api/graphql/. Match both hosts + legacy twitter.com.
const TWITTER_GRAPHQL_URLS = [
    "*://api.x.com/graphql/*",
    "*://x.com/i/api/graphql/*",
    "*://api.twitter.com/graphql/*",
    "*://twitter.com/i/api/graphql/*"
];

// Read the GraphQL response INLINE as it streams through, the same way the
// Instagram / Vimeo paths do (collectFilteredResponse). This replaces the old
// re-fetch-the-request approach, which: doubled every request (risking x.com's
// rate limit), had to copy auth/CSRF headers, and broke on POST timelines
// because a GET replay dropped the body (the "VPN" bug). filterResponseData
// taps the user's own authenticated response, so method/body/auth are never
// our concern and there are zero extra requests.
function listenerTwitterGraphql(details) {
    const kind = twitterQueryKind(details.url);
    if (!kind) return {};

    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("TWITTER", "filter create failed", { error: e.message });
        return {};
    }

    const chunks = [];
    filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data); // pass through unmodified
    };
    filter.onstop = () => {
        filter.close();
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        if (total === 0) return;
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { combined.set(c, offset); offset += c.byteLength; }
        const parsed = tryParseJson(new TextDecoder("utf-8").decode(combined));
        if (!parsed) { log("TWITTER", "response not JSON", { kind, bytes: total }); return; }
        // Off the filter callback to avoid holding the stream stop.
        Promise.resolve().then(() => processTwitterResponse(details, kind, parsed));
    };
    filter.onerror = () => {
        try { filter.close(); } catch (_) {}
    };

    return {};
}

browser.webRequest.onBeforeRequest.addListener(
    listenerTwitterGraphql,
    { urls: TWITTER_GRAPHQL_URLS, types: ["xmlhttprequest"] },
    ["blocking"]
);

// ============================================================================
// Kick
// ============================================================================

const processedKickUrls = new Set();

/**
 * Extract slug from Kick URLs.
 * Matches: kick.com/{streamer}, kick.com/{streamer}/clips/{clipId},
 *          kick.com/video/{videoId}
 */
function parseKickUrl(url) {
    // Clip: kick.com/{streamer}/clips/{clipId} or kick.com/clips/{clipId}
    let m = url.match(/kick\.com\/(?:([A-Za-z0-9_-]+)\/)?clips?\/([\w-]+)/);
    if (m) return { type: "clip", streamer: m[1] || null, clipId: m[2] };

    // VOD: kick.com/video/{uuid} or kick.com/{streamer}/videos/{uuid}
    m = url.match(/kick\.com\/(?:[A-Za-z0-9_-]+\/)?videos?\/([\w-]+)/);
    if (m) return { type: "video", videoId: m[1] };

    // Channel page: kick.com/{streamer} (not api, not static paths)
    // Must not have further path segments (avoid matching /streamer/videos etc)
    m = url.match(/kick\.com\/([A-Za-z0-9_][A-Za-z0-9_-]{0,24})(?:[?#]|$)/);
    if (m && !["api", "video", "videos", "clips", "categories", "search", "settings", "following", "stream",
               "browse", "terms", "privacy", "about", "help", "contact", "dmca", "community-guidelines",
               "responsible-gambling", "dashboard", "auth", "login", "signup", "invite"].includes(m[1].toLowerCase())) {
        return { type: "channel", streamer: m[1] };
    }

    return null;
}

/**
 * Pick best thumbnail from Kick's responsive thumbnail string.
 */
function pickKickThumbnail(thumbnail) {
    if (!thumbnail) return null;
    if (typeof thumbnail === "string") {
        // If it's a URL already
        if (thumbnail.startsWith("http")) return thumbnail;
        return null;
    }
    // Responsive srcset string — pick the largest
    const srcset = thumbnail.responsive || thumbnail.url || thumbnail.src;
    if (typeof srcset === "string" && srcset.includes("http")) {
        const urls = srcset.match(/https?:\/\/[^\s,]+/g);
        return urls ? urls[0] : null;
    }
    return null;
}

async function fetchKickChannel(details, streamer) {
    const key = `kick-channel-${streamer}`;
    if (processedKickUrls.has(key)) return;
    processedKickUrls.add(key);
    setTimeout(() => processedKickUrls.delete(key), 10_000);

    await ensureTabId(details);
    log("KICK", `Fetching channel`, { streamer });

    try {
        const apiUrl = `https://kick.com/api/v2/channels/${streamer}`;
        const resp = await fetch(apiUrl, {
            credentials: "include",
            headers: { "Accept": "application/json" }
        });
        log("KICK", `API response`, { status: resp.status });
        if (!resp.ok) return;

        const data = tryParseJson(await resp.text());
        if (!data) { log("KICK", `Not valid JSON`); return; }

        processKickChannelData(details, data);
    } catch (e) {
        log("KICK", `Channel fetch error`, e.message);
    }
}

async function fetchKickClip(details, clipId) {
    const key = `kick-clip-${clipId}`;
    if (processedKickUrls.has(key)) return;
    processedKickUrls.add(key);
    setTimeout(() => processedKickUrls.delete(key), 10_000);

    await ensureTabId(details);
    log("KICK", `Fetching clip`, { clipId });

    try {
        const apiUrl = `https://kick.com/api/v2/clips/${clipId}`;
        markOwnRequest(apiUrl);
        const resp = await fetch(apiUrl, {
            headers: { "Accept": "application/json" }
        });
        if (!resp.ok) return;

        const data = tryParseJson(await resp.text());
        const clip = data?.clip || data;
        if (!clip) return;

        const videoUrl = clip.video_url || clip.clip_url;
        if (!videoUrl) { log("KICK", `No video URL in clip`); return; }

        const origin = `https://kick.com/clips/${clipId}`;
        if (alreadySent(origin)) return;

        const tabId = await resolveTabId(details);
        const name = clip.channel?.username || clip.creator?.username || "Kick Clip";
        const title = clip.title || "";
        const img = clip.thumbnail_url || pickKickThumbnail(clip.thumbnail) || null;
        const duration = Math.round((clip.duration || 0) * 1000);

        // Enumerate the HLS master into quality variants (no ffprobe); falls back
        // to the single URL if it isn't a parseable master.
        await emitHlsMasterOrSingle(details, { url: videoUrl, origin, tabId, name, title, img, duration });
        log("KICK", `Sent clip`, { clipId, name });
    } catch (e) {
        log("KICK", `Clip error`, e.message);
    }
}

async function fetchKickVideo(details, videoId) {
    const key = `kick-video-${videoId}`;
    if (processedKickUrls.has(key)) return;
    processedKickUrls.add(key);
    setTimeout(() => processedKickUrls.delete(key), 10_000);

    await ensureTabId(details);
    log("KICK", `Fetching video`, { videoId });

    try {
        const apiUrl = `https://kick.com/api/v1/video/${videoId}`;
        markOwnRequest(apiUrl);
        const resp = await fetch(apiUrl, {
            headers: { "Accept": "application/json" }
        });
        if (!resp.ok) return;

        const data = tryParseJson(await resp.text());
        if (!data) return;

        const videoUrl = data.source || data.livestream?.source;
        if (!videoUrl) { log("KICK", `No source URL in video`); return; }

        const origin = `https://kick.com/video/${videoId}`;
        if (alreadySent(origin)) return;

        const tabId = await resolveTabId(details);
        const name = data.livestream?.channel?.user?.username || "Kick VOD";
        const title = data.livestream?.session_title || "";
        const img = pickKickThumbnail(data.livestream?.thumbnail) || null;
        const duration = Math.round((data.livestream?.duration || 0));

        // Enumerate the HLS master into quality variants (no ffprobe); falls back
        // to the single URL if it isn't a parseable master.
        await emitHlsMasterOrSingle(details, { url: videoUrl, origin, tabId, name, title, img, duration });
        log("KICK", `Sent VOD`, { videoId, name });
    } catch (e) {
        log("KICK", `Video error`, e.message);
    }
}

function listenerKickPage(details) {
    log("KICK", `Page request intercepted`, { url: details.url, type: details.type, tabId: details.tabId });
    if (details.type !== "main_frame") return;
    const parsed = parseKickUrl(details.url);
    log("KICK", `URL parsed`, parsed || "no match");
    if (!parsed) return;

    if (details.tabId >= 0) cacheTabUrl(details.url, details.tabId);

    if (parsed.type === "channel") {
        fetchKickChannel(details, parsed.streamer);
    } else if (parsed.type === "clip" && parsed.clipId) {
        fetchKickClip(details, parsed.clipId);
    } else if (parsed.type === "video" && parsed.videoId) {
        fetchKickVideo(details, parsed.videoId);
    }
}

// Intercept Kick API responses — use onCompleted to re-fetch with cookies after browser succeeds
function listenerKickApiComplete(details) {
    // Only process the channel endpoint itself
    const channelMatch = details.url.match(/\/api\/v2\/channels\/([A-Za-z0-9_-]+)\/?(?:\?|$)/);
    if (!channelMatch) return;

    const streamer = channelMatch[1];
    log("KICK", `Browser API call completed`, { streamer, status: details.statusCode });

    if (details.statusCode !== 200) return;

    // Re-fetch with credentials to get the JSON (browser already cleared Cloudflare)
    const key = `kick-api-${streamer}`;
    if (processedKickUrls.has(key)) return;
    processedKickUrls.add(key);
    setTimeout(() => processedKickUrls.delete(key), 10_000);

    (async () => {
        try {
            const resp = await fetch(details.url, {
                credentials: "include",
                headers: { "Accept": "application/json" }
            });
            if (!resp.ok) { log("KICK", `Re-fetch failed`, { status: resp.status }); return; }

            const data = tryParseJson(await resp.text());
            if (!data) return;

            processKickChannelData(details, data);
        } catch (e) {
            log("KICK", `Re-fetch error`, e.message);
        }
    })();
}

function processKickChannelData(details, data) {
    const playbackUrl = data.playback_url;
    const livestream = data.livestream || data.recent_livestream;
    const slug = data.slug || data.user?.username;

    log("KICK", `Channel data`, {
        slug,
        username: data.user?.username,
        hasPlaybackUrl: !!playbackUrl,
        isLive: livestream?.is_live || false
    });

    if (!playbackUrl) {
        log("KICK", `Channel offline`, { slug });
        return;
    }

    const origin = `https://kick.com/${slug}`;
    if (alreadySent(origin)) return;
    markSent(origin);

    const title = livestream?.session_title || data.user?.username || slug;
    const img = pickKickThumbnail(livestream?.thumbnail)
        || data.user?.profilepic || data.user?.profile_pic || null;
    const name = data.user?.username || slug;
    const category = livestream?.categories?.[0]?.name || "";

    sendNative({
        url: playbackUrl,
        type: "media",
        origin,
        tabId: details.tabId >= 0 ? details.tabId : -1,
        request: details.requestId || `kick-${Date.now()}`,
        name,
        description: category ? `${title} — ${category}` : title,
        img
    });
    log("KICK", `Sent live stream`, { slug, name, title: title.slice(0, 50) });
}

browser.webRequest.onBeforeRequest.addListener(
    listenerKickPage,
    { urls: ["*://kick.com/*", "*://www.kick.com/*", "*://m.kick.com/*"], types: ["main_frame"] },
    []
);

browser.webRequest.onCompleted.addListener(
    listenerKickApiComplete,
    { urls: ["*://kick.com/api/v2/channels/*", "*://www.kick.com/api/v2/channels/*"], types: ["xmlhttprequest"] }
);

// ============================================================================
// Twitch
// ============================================================================

const TWITCH_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const processedTwitchUrls = new Set();
let twitchAuthToken = null;
let twitchDeviceId = null;

// ---- CDN M3U8 capture + metadata rendezvous ----
//
// Strategy: instead of building our own usher URL (which Twitch fills with ads),
// we capture the M3U8 URLs that the browser's own Twitch player fetches.
// The player's requests go through Twitch's ad pipeline first, and by the time
// the variant playlist is being fetched from the CDN, ads have been negotiated.
//
// We capture URLs from:
//   - usher.ttvnw.net (master playlists)
//   - video-weaver.*.hls.ttvnw.net (variant/segment playlists)
//   - *.abs.hls.ttvnw.net (VOD playlists)
//   - d2nvs31859zcd8.cloudfront.net (alternate CDN)
//
// These are married with metadata from GQL (title, thumbnail, game, etc).
// Whichever side arrives second triggers sendNative.

const TWITCH_RENDEZVOUS_TTL = 30_000;
const twitchRendezvous = new Map();

function getTwitchRendezvous(key) {
    let entry = twitchRendezvous.get(key);
    if (entry && Date.now() - entry.timestamp > TWITCH_RENDEZVOUS_TTL) {
        twitchRendezvous.delete(key);
        entry = null;
    }
    if (!entry) {
        entry = { m3u8Url: null, metadata: null, details: null, variants: null, bodyPending: false, bodyDone: false, timestamp: Date.now() };
        twitchRendezvous.set(key, entry);
    }
    return entry;
}

function tryCompleteTwitchRendezvous(key) {
    const entry = twitchRendezvous.get(key);
    if (!entry || !entry.m3u8Url || !entry.metadata) return;

    const { m3u8Url, metadata, details } = entry;
    twitchRendezvous.delete(key);

    // Hand the master to native: Java OkHttp-fetches it and M3U8Parser enumerates
    // the qualities (no ffprobe), falling back to a media capture on failure.
    // enumerateMasterNative does its own origin dedup.
    log("TWITCH", `Rendezvous complete — enumerate master`, { key, url: m3u8Url.slice(0, 120) });
    enumerateMasterNative(details || { tabId: -1, requestId: `twitch-${Date.now()}` }, {
        url: m3u8Url,
        origin: metadata.origin,
        name: metadata.name,
        description: metadata.description,
        img: metadata.img,
        duration: metadata.duration
    });
}

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of twitchRendezvous) {
        if (now - entry.timestamp > TWITCH_RENDEZVOUS_TTL) twitchRendezvous.delete(key);
    }
}, TWITCH_RENDEZVOUS_TTL);

/**
 * Resolve the Twitch channel login from a tab ID by looking up cached tab URLs.
 */
function resolveLoginFromTab(tabId) {
    if (tabId < 0) return null;
    for (const [url, entry] of urlToTabCache) {
        if (entry.tabId === tabId) {
            const m = url.match(/twitch\.tv\/([A-Za-z0-9_]{1,25})(?:[?#/]|$)/);
            if (m && !["directory", "videos", "settings", "subscriptions", "inventory",
                       "drops", "wallet", "search", "clips"].includes(m[1].toLowerCase())) {
                return m[1].toLowerCase();
            }
        }
    }
    return null;
}

function resolveVodIdFromTab(tabId) {
    if (tabId < 0) return null;
    for (const [url, entry] of urlToTabCache) {
        if (entry.tabId === tabId) {
            const m = url.match(/twitch\.tv\/videos\/(\d+)/);
            if (m) return m[1];
        }
    }
    return null;
}

/**
 * CDN M3U8 listener — captures any .m3u8 request from ttvnw.net.
 *
 * Instead of parsing the CDN URL (which changes across API versions and
 * CDN hostnames), we resolve the channel/VOD from the tab that initiated
 * the request.  The tab URL (twitch.tv/{login} or twitch.tv/videos/{id})
 * is the stable ground truth.
 */
// Record the master URL + tab context, then complete the rendezvous (which hands
// the master to native for OkHttp fetch + Java enumeration). No body capture
// here — Java fetches and parses it.
function captureTwitchMaster(key, details) {
    const entry = getTwitchRendezvous(key);
    if (entry.m3u8Url) return; // first .m3u8 only
    log("TWITCH-CDN", `Captured M3U8 for ${key}`, { tabId: details.tabId, url: details.url.slice(0, 120) });
    entry.m3u8Url = details.url;
    if (!entry.details && details.tabId >= 0) {
        entry.details = { tabId: details.tabId, _resolvedTabId: details.tabId, requestId: `cdn-${Date.now()}` };
    }
    tryCompleteTwitchRendezvous(key);
}

function listenerTwitchCdnM3u8(details) {
    if (isOwnRequest(details.url)) return;

    const tabLogin = resolveLoginFromTab(details.tabId);
    if (tabLogin) { captureTwitchMaster(tabLogin, details); return; }

    const tabVodId = resolveVodIdFromTab(details.tabId);
    if (tabVodId) { captureTwitchMaster(`vod-${tabVodId}`, details); return; }

    log("TWITCH-CDN", `M3U8 captured but no tab match`, { tabId: details.tabId, url: details.url.slice(0, 80) });
}

// Broad pattern — catches any M3U8 from any ttvnw.net subdomain.
// Registered "blocking" because captureTwitchMaster uses filterResponseData
// (which requires it) to read the master playlist body.
browser.webRequest.onBeforeRequest.addListener(
    listenerTwitchCdnM3u8,
    { urls: ["*://*.ttvnw.net/*.m3u8*"] },
    ["blocking"]
);

/**
 * Parse Twitch URLs.
 * Matches: twitch.tv/{channel}, twitch.tv/videos/{id}, twitch.tv/{channel}/clip/{slug}
 */
function parseTwitchUrl(url) {
    // Clip: twitch.tv/{channel}/clip/{slug} or clips.twitch.tv/{slug}
    let m = url.match(/twitch\.tv\/\w+\/clip\/([A-Za-z0-9_-]+)/) || url.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/);
    if (m) return { type: "clip", slug: m[1] };

    // VOD: twitch.tv/videos/{id}
    m = url.match(/twitch\.tv\/videos\/(\d+)/);
    if (m) return { type: "vod", vodId: m[1] };

    // Channel: twitch.tv/{channel}
    m = url.match(/twitch\.tv\/([A-Za-z0-9_]{1,25})(?:[?#/]|$)/);
    if (m && !["directory", "videos", "settings", "subscriptions", "inventory", "drops", "wallet", "search"].includes(m[1].toLowerCase())) {
        return { type: "channel", login: m[1] };
    }

    return null;
}

/**
 * Capture Client-ID, OAuth token, and Device-ID from Twitch GQL requests.
 */
let _lastTwitchAuthState = "";
function captureTwitchHeaders(details) {
    let changed = false;
    for (const h of details.requestHeaders) {
        const name = h.name.toLowerCase();
        if (name === "authorization" && h.value?.startsWith("OAuth ")) {
            if (twitchAuthToken !== h.value) changed = true;
            twitchAuthToken = h.value;
        } else if (name === "x-device-id" && h.value) {
            if (twitchDeviceId !== h.value) changed = true;
            twitchDeviceId = h.value;
        }
    }
    const state = `auth=${!!twitchAuthToken},device=${!!twitchDeviceId}`;
    if (changed || state !== _lastTwitchAuthState) {
        _lastTwitchAuthState = state;
        log("TWITCH", `Headers captured`, { hasAuth: !!twitchAuthToken, hasDeviceId: !!twitchDeviceId });
    }
}

browser.webRequest.onSendHeaders.addListener(
    captureTwitchHeaders,
    { urls: ["*://gql.twitch.tv/*"], types: ["xmlhttprequest"] },
    ["requestHeaders"]
);

function buildTwitchGqlHeaders() {
    const headers = {
        "Client-ID": TWITCH_CLIENT_ID,
        "Content-Type": "application/json"
    };
    if (twitchAuthToken) headers["Authorization"] = twitchAuthToken;
    if (twitchDeviceId) headers["X-Device-Id"] = twitchDeviceId;
    return headers;
}

/**
 * Fetch live stream metadata via GQL and store in rendezvous.
 * The actual M3U8 URL comes from the CDN listener (the browser's player).
 * Falls back to self-built usher URL if no CDN capture arrives within timeout.
 */
async function fetchTwitchLiveStream(details, login) {
    const key = `twitch-live-${login}`;
    if (processedTwitchUrls.has(key)) { log("TWITCH", `Already processing ${login}, skipping`); return; }
    processedTwitchUrls.add(key);
    setTimeout(() => processedTwitchUrls.delete(key), 30_000);

    await ensureTabId(details);
    const loginLower = login.toLowerCase();
    log("TWITCH", `Fetching live stream metadata`, { login });

    try {
        const headers = buildTwitchGqlHeaders();

        const resp = await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers,
            body: JSON.stringify([{
                operationName: "StreamMetadata",
                query: `query StreamMetadata($channelLogin: String!) {
                    user(login: $channelLogin) {
                        displayName
                        login
                        profileImageURL(width: 300)
                        stream {
                            title
                            previewImageURL(width: 1280, height: 720)
                            game { displayName }
                        }
                    }
                }`,
                variables: { channelLogin: login }
            }, {
                operationName: "PlaybackAccessToken_Template",
                query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
                    streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }
                    videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename }
                }`,
                variables: { isLive: true, login, isVod: false, vodID: "", playerType: "site" }
            }])
        });

        const results = tryParseJson(await resp.text());
        if (!results || !Array.isArray(results)) {
            log("TWITCH", `Parse failed or not array`);
            return;
        }

        const userData = results[0]?.data?.user;
        if (!userData?.stream) {
            log("TWITCH", `Channel offline`, { login });
            processedTwitchUrls.delete(key);
            return;
        }

        const stream = userData.stream;
        const displayName = userData.displayName || login;
        const title = stream.title || login;
        const gameName = stream.game?.displayName || "";
        const previewUrl = stream.previewImageURL || null;
        const profileImg = userData.profileImageURL || null;

        const entry = getTwitchRendezvous(loginLower);
        entry.metadata = {
            origin: `https://www.twitch.tv/${login}`,
            name: displayName,
            description: gameName ? `${title} — ${gameName}` : title,
            img: previewUrl || profileImg,
            duration: 0
        };
        entry.details = details;

        log("TWITCH", `Metadata stored in rendezvous`, { login: loginLower, hasM3u8: !!entry.m3u8Url });
        tryCompleteTwitchRendezvous(loginLower);

        // Fallback: if CDN capture doesn't arrive within 10s, use self-built usher URL
        setTimeout(() => {
            const pending = twitchRendezvous.get(loginLower);
            if (pending && pending.metadata && !pending.m3u8Url) {
                log("TWITCH", `CDN capture timeout — using fallback usher URL`, { login });

                const accessToken = results[1]?.data?.streamPlaybackAccessToken;
                if (!accessToken?.value || !accessToken?.signature) {
                    log("TWITCH", `No access token for fallback`);
                    twitchRendezvous.delete(loginLower);
                    return;
                }

                const hlsUrl = `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`
                    + `?sig=${accessToken.signature}`
                    + `&token=${encodeURIComponent(accessToken.value)}`
                    + `&allow_source=true&allow_audio_only=true`
                    + `&p=${Math.floor(Math.random() * 999999)}`;

                pending.m3u8Url = hlsUrl;
                tryCompleteTwitchRendezvous(loginLower);
            }
        }, 10_000);

    } catch (e) {
        log("TWITCH", `Live error`, e.message);
    }
}

/**
 * Fetch VOD metadata via GQL and store in rendezvous.
 * Actual M3U8 URL comes from CDN listener; falls back to usher URL on timeout.
 */
async function fetchTwitchVod(details, vodId) {
    const key = `twitch-vod-${vodId}`;
    if (processedTwitchUrls.has(key)) return;
    processedTwitchUrls.add(key);
    setTimeout(() => processedTwitchUrls.delete(key), 30_000);

    await ensureTabId(details);
    const rvKey = `vod-${vodId}`;
    log("TWITCH", `Fetching VOD metadata`, { vodId });

    try {
        const headers = buildTwitchGqlHeaders();

        const resp = await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers,
            body: JSON.stringify([{
                operationName: "VideoMetadata",
                query: `query VideoMetadata($videoID: ID!) {
                    video(id: $videoID) {
                        title
                        lengthSeconds
                        previewThumbnailURL(width: 1280, height: 720)
                        owner { displayName login profileImageURL(width: 300) }
                        game { displayName }
                    }
                }`,
                variables: { videoID: vodId }
            }, {
                operationName: "PlaybackAccessToken_Template",
                query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
                    streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) { value signature __typename }
                    videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) { value signature __typename }
                }`,
                variables: { isLive: false, login: "", isVod: true, vodID: vodId, playerType: "site" }
            }])
        });

        const results = tryParseJson(await resp.text());
        if (!Array.isArray(results) || results.length < 2) return;

        const videoData = results[0]?.data?.video;
        const owner = videoData?.owner;
        const vodName = owner?.displayName || owner?.login || "Twitch VOD";
        const title = videoData?.title || `VOD ${vodId}`;
        const gameName = videoData?.game?.displayName || "";
        const previewUrl = videoData?.previewThumbnailURL
            ? videoData.previewThumbnailURL.replace("{width}", "1280").replace("{height}", "720")
            : null;
        const duration = videoData?.lengthSeconds ? videoData.lengthSeconds * 1000 : 0;

        const entry = getTwitchRendezvous(rvKey);
        entry.metadata = {
            origin: `https://www.twitch.tv/videos/${vodId}`,
            name: vodName,
            description: gameName ? `${title} — ${gameName}` : title,
            img: previewUrl,
            duration
        };
        entry.details = details;

        log("TWITCH", `VOD metadata stored in rendezvous`, { vodId, hasM3u8: !!entry.m3u8Url });
        tryCompleteTwitchRendezvous(rvKey);

        // Fallback
        setTimeout(() => {
            const pending = twitchRendezvous.get(rvKey);
            if (pending && pending.metadata && !pending.m3u8Url) {
                log("TWITCH", `VOD CDN capture timeout — using fallback usher URL`, { vodId });

                const accessToken = results[1]?.data?.videoPlaybackAccessToken;
                if (!accessToken?.value || !accessToken?.signature) {
                    twitchRendezvous.delete(rvKey);
                    return;
                }

                const hlsUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8`
                    + `?sig=${accessToken.signature}`
                    + `&token=${encodeURIComponent(accessToken.value)}`
                    + `&allow_source=true`
                    + `&p=${Math.floor(Math.random() * 999999)}`;

                pending.m3u8Url = hlsUrl;
                tryCompleteTwitchRendezvous(rvKey);
            }
        }, 10_000);

    } catch (e) {
        log("TWITCH", `VOD error`, e.message);
    }
}

/**
 * Fetch clip — clips are MP4, not HLS. Can send as variants.
 */
async function fetchTwitchClip(details, slug) {
    const key = `twitch-clip-${slug}`;
    if (processedTwitchUrls.has(key)) return;
    processedTwitchUrls.add(key);
    setTimeout(() => processedTwitchUrls.delete(key), 10_000);

    await ensureTabId(details);
    log("TWITCH", `Fetching clip`, { slug });

    try {
        const headers = buildTwitchGqlHeaders();

        const resp = await fetch("https://gql.twitch.tv/gql", {
            method: "POST",
            headers,
            body: JSON.stringify({
                operationName: "VideoAccessToken_Clip",
                query: `query VideoAccessToken_Clip($slug: ID!) {
                    clip(slug: $slug) {
                        playbackAccessToken(params: {platform: "web", playerType: "site"}) { value signature __typename }
                        videoQualities { sourceURL quality frameRate }
                        broadcaster { displayName login }
                        title
                        thumbnailURL
                        durationSeconds
                    }
                }`,
                variables: { slug }
            })
        });

        const results = tryParseJson(await resp.text());
        const clipData = results?.data?.clip;
        if (!clipData) { log("TWITCH", `No clip data`, { slug }); return; }

        const token = clipData.playbackAccessToken;
        const qualities = clipData.videoQualities;
        if (!token || !Array.isArray(qualities) || qualities.length === 0) return;

        // Clips are direct MP4 URLs with quality variants
        // Compute width from 16:9 ratio (standard Twitch aspect ratio)
        const variants = qualities.map(q => {
            const url = `${q.sourceURL}?sig=${token.signature}&token=${encodeURIComponent(token.value)}`;
            const height = parseInt(q.quality) || 0;
            const width = height > 0 ? Math.round(height * 16 / 9) : 0;
            return { url, width, height };
        });

        const origin = `https://clips.twitch.tv/${slug}`;
        const broadcaster = clipData.broadcaster;
        const title = clipData.title || "";
        const thumbnailUrl = clipData.thumbnailURL || null;
        const duration = Math.round((clipData.durationSeconds || 0) * 1000);

        sendVariants(details, {
            variants,
            origin,
            name: broadcaster?.displayName || broadcaster?.login || "Twitch Clip",
            description: title,
            img: thumbnailUrl,
            duration
        });
        log("TWITCH", `Sent clip`, { slug, qualities: qualities.length });
    } catch (e) {
        log("TWITCH", `Clip error`, e.message);
    }
}

function listenerTwitchPage(details) {
    log("TWITCH", `Page request intercepted`, { url: details.url, type: details.type, tabId: details.tabId });
    if (details.type !== "main_frame") return;
    const parsed = parseTwitchUrl(details.url);
    log("TWITCH", `URL parsed`, parsed || "no match");
    if (!parsed) return;

    if (details.tabId >= 0) cacheTabUrl(details.url, details.tabId);

    if (parsed.type === "channel") {
        fetchTwitchLiveStream(details, parsed.login);
    } else if (parsed.type === "vod") {
        fetchTwitchVod(details, parsed.vodId);
    } else if (parsed.type === "clip") {
        fetchTwitchClip(details, parsed.slug);
    }
}

browser.webRequest.onBeforeRequest.addListener(
    listenerTwitchPage,
    { urls: ["*://www.twitch.tv/*", "*://m.twitch.tv/*", "*://clips.twitch.tv/*"], types: ["main_frame"] },
    []
);

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
function processDailymotionData(details, data, videoId) {
    const origin = `https://www.dailymotion.com/video/${videoId}`;
    if (alreadySent(origin)) {
        log("DAILYMOTION", `Already sent`, { videoId });
        return;
    }

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

    markSent(origin);

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

    const tabId = details.tabId >= 0 ? details.tabId : (details._resolvedTabId ?? -1);

    const message = {
        url: hlsUrl,
        type: "media",
        origin,
        tabId,
        request: details.requestId || `dm-${Date.now()}`,
        name,
        description: title,
    };

    if (img) message.img = img;
    if (duration > 0) message.duration = duration;

    log("DAILYMOTION", `Sending video`, { videoId, name, hasImg: !!img });
    sendNative(message);
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

// ============================================================================
// Instagram — helpers
// ============================================================================

const INSTAGRAM_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://www.instagram.com",
    "Referer": "https://www.instagram.com",
    "Accept-Language": "en-us,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept": "*/*"
};

function getInstagramThumbnail(item) {
    // API v1 shape: image_versions2.candidates[] sorted by width
    const candidates = item?.image_versions2?.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
        return [...candidates].sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
    }

    // GraphQL shapes
    if (item?.display_url) return item.display_url;
    if (item?.thumbnail_src) return item.thumbnail_src;
    if (item?.thumbnail_url) return item.thumbnail_url;

    // Clips/reels cover frame
    if (item?.media_cropping_info?.thumbnails?.[0]?.url) return item.media_cropping_info.thumbnails[0].url;

    // Profile pic of the owner as last resort for stories
    if (item?.user?.profile_pic_url) return item.user.profile_pic_url;

    return null;
}

async function getInstagramCookies() {
    try {
        const cached = await browser.storage.local.get(COOKIE_CACHE_KEY);
        if (cached[COOKIE_CACHE_KEY]) {
            const { value, timestamp } = cached[COOKIE_CACHE_KEY];
            if (Date.now() - timestamp < COOKIE_CACHE_TTL) return value;
        }

        const cookies = await browser.cookies.getAll({ domain: ".instagram.com" });
        if (cookies.length === 0) return null;

        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        await browser.storage.local.set({
            [COOKIE_CACHE_KEY]: { value: cookieString, timestamp: Date.now() }
        });

        log("INSTAGRAM", `Cached ${cookies.length} cookies`);
        return cookieString;
    } catch (e) {
        log("INSTAGRAM", `Failed to get cookies`, e.message);
        return null;
    }
}

async function fetchInstagramGraphQL(shortcode, cookieString) {
    const graphqlUrl = `https://www.instagram.com/graphql/query/?doc_id=8845758582119845&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
    markOwnRequest(graphqlUrl);

    const response = await fetch(graphqlUrl, {
        method: "GET",
        headers: new Headers({ ...INSTAGRAM_HEADERS, "Cookie": cookieString })
    });

    return tryParseJson(await response.text());
}

// ============================================================================
// Instagram — video extraction from different response shapes
// ============================================================================

/**
 * Extract and send videos from an Instagram media API item.
 */
function sendInstagramItem(details, item, originOverride) {
    const videoText = item.caption?.text || "";
    const author = item.user?.username || null;
    const code = item.code;
    const origin = originOverride || `https://www.instagram.com/p/${code}`;
    const img = getInstagramThumbnail(item);
    const duration = Math.round((item.video_duration || 0) * 1000);

    log("IG-ITEM", `sendInstagramItem called`, {
        code,
        author,
        origin,
        mediaType: item.media_type,
        hasVideoVersions: !!item.video_versions,
        videoVersionsCount: item.video_versions?.length || 0,
        hasCarousel: !!item.carousel_media,
        carouselCount: item.carousel_media?.length || 0,
        hasImg: !!img,
        imgSource: img ? (
            item?.image_versions2?.candidates?.length ? "image_versions2" :
            item?.display_url ? "display_url" :
            item?.thumbnail_src ? "thumbnail_src" :
            item?.thumbnail_url ? "thumbnail_url" :
            "other"
        ) : "none",
        duration
    });

    if (item.video_versions) {
        const variants = item.video_versions.map(v => ({
            url: v.url, width: v.width || 0, height: v.height || 0
        }));
        log("IG-ITEM", `Sending ${variants.length} video variant(s)`, { code, firstUrl: variants[0]?.url?.slice(0, 80) });
        sendVariants(details, { variants, origin, description: videoText, img, name: author, duration });
    }

    if (item.carousel_media) {
        let carouselVideos = 0;
        for (const media of item.carousel_media) {
            if (!media.video_versions) continue;
            carouselVideos++;
            const variants = media.video_versions.map(v => ({
                url: v.url, width: v.width || 0, height: v.height || 0
            }));
            const mediaImg = getInstagramThumbnail(media) || img;
            const mediaDuration = Math.round((media.video_duration || 0) * 1000);
            sendVariants(details, { variants, origin, description: videoText, img: mediaImg, name: author, duration: mediaDuration });
        }
        log("IG-ITEM", `Carousel: ${carouselVideos} video(s) in ${item.carousel_media.length} slides`, { code });
    }

    if (!item.video_versions && !item.carousel_media) {
        log("IG-ITEM", `Item has no video_versions and no carousel_media — nothing to send`, { code, mediaType: item.media_type });
    }
}

/**
 * Extract and send videos from an Instagram GraphQL response.
 */
function parseInstagramQuery(details, parsed) {
    const shortcodeMedia = parsed.data?.xdt_shortcode_media;
    if (shortcodeMedia) {
        const code = shortcodeMedia.shortcode;
        const origin = `https://www.instagram.com/p/${code}`;
        const text = shortcodeMedia.edge_media_to_caption?.edges?.[0]?.node?.text || "";
        const img = shortcodeMedia.display_url || shortcodeMedia.thumbnail_src || null;
        const duration = Math.round((shortcodeMedia.video_duration || 0) * 1000);
        const author = shortcodeMedia.owner?.username || null;

        if (shortcodeMedia.__typename === "XDTGraphSidecar") {
            for (const { node } of (shortcodeMedia.edge_sidecar_to_children?.edges || [])) {
                if (node?.__typename !== "XDTGraphVideo") continue;
                const nodeImg = node.display_url || img;
                const nodeDuration = Math.round((node.video_duration || 0) * 1000);
                sendVariants(details, {
                    variants: [{ url: node.video_url, width: node.dimensions?.width || 0, height: node.dimensions?.height || 0 }],
                    origin, description: text, img: nodeImg, name: author, duration: nodeDuration
                });
            }
        } else if (shortcodeMedia.video_url) {
            sendVariants(details, {
                variants: [{ url: shortcodeMedia.video_url, width: shortcodeMedia.dimensions?.width || 0, height: shortcodeMedia.dimensions?.height || 0 }],
                origin, description: text, img, name: author, duration
            });
        }
        return;
    }

    const timeline = parsed.data?.user?.edge_owner_to_timeline_media;
    if (timeline?.edges) {
        for (const { node } of timeline.edges) {
            if (node?.__typename !== "GraphVideo" || !node.video_url) continue;
            const code = node.shortcode;
            const origin = `https://www.instagram.com/p/${code}`;
            const text = node.edge_media_to_caption?.edges?.[0]?.node?.text || "";
            const nodeImg = node.display_url || node.thumbnail_src || null;
            const nodeDuration = Math.round((node.video_duration || 0) * 1000);
            const author = node.owner?.username || null;
            sendVariants(details, {
                variants: [{ url: node.video_url, width: node.dimensions?.width || 0, height: node.dimensions?.height || 0 }],
                origin, description: text, img: nodeImg, name: author, duration: nodeDuration
            });
        }
    }
}

// ============================================================================
// Instagram — fetch strategies
// ============================================================================

const pendingShortcodes = new Set();

/**
 * Primary entry point for fetching Instagram content by shortcode.
 * Uses GraphQL directly (media API needs numeric ID, not shortcode).
 */
async function fetchInstagramByShortcode(details, shortcode) {
    if (pendingShortcodes.has(shortcode)) {
        log("INSTAGRAM", `Already fetching shortcode, skipping`, { shortcode });
        return;
    }

    pendingShortcodes.add(shortcode);
    log("INSTAGRAM", `Fetching by shortcode`, { shortcode });

    await ensureTabId(details);
    const cookieString = await getInstagramCookies();

    if (!cookieString) {
        details.shortcode = shortcode;
        addToInstagramQueue(details);
        pendingShortcodes.delete(shortcode);
        return;
    }

    try {
        const parsed = await fetchInstagramGraphQL(shortcode, cookieString);
        if (parsed) {
            parseInstagramQuery(details, parsed);
        } else {
            log("INSTAGRAM", `GraphQL response failed to parse`);
        }
    } catch (e) {
        log("INSTAGRAM", `Shortcode fetch error`, e.message);
    } finally {
        pendingShortcodes.delete(shortcode);
        log("INSTAGRAM", `Finished processing shortcode`, { shortcode });
    }
}

/**
 * Fetch Instagram content by numeric media ID.
 * Falls back to GraphQL via shortcode if media API fails.
 */
async function fetchInstagramByMediaId(details, mediaId, shortcode) {
    log("INSTAGRAM", `Fetching media info`, { mediaId, shortcode });

    await ensureTabId(details);
    const cookieString = await getInstagramCookies();

    if (!cookieString) {
        details.shortcode = shortcode || mediaId;
        addToInstagramQueue(details);
        return;
    }

    const headers = new Headers({ ...INSTAGRAM_HEADERS, "Cookie": cookieString });

    try {
        const mediaUrl = `https://www.instagram.com/api/v1/media/${mediaId}/info/`;
        markOwnRequest(mediaUrl);

        const response = await fetch(mediaUrl, { method: "GET", headers });
        const parsed = tryParseJson(await response.text());

        if (parsed?.items?.[0]) {
            sendInstagramItem(details, parsed.items[0]);
            return;
        }

        log("INSTAGRAM", `Media API returned no items, trying GraphQL fallback`);

        if (shortcode) {
            const graphqlParsed = await fetchInstagramGraphQL(shortcode, cookieString);
            if (graphqlParsed) {
                parseInstagramQuery(details, graphqlParsed);
            }
        }
    } catch (e) {
        log("INSTAGRAM", `Media fetch error`, e.message);
    }
}

// ============================================================================
// Instagram — webRequest listeners (filterResponseData + content script fallback)
// ============================================================================

/**
 * Primary strategy: use filterResponseData to intercept API responses inline.
 * This reads the response as it streams through without replaying the request.
 * Falls back to content script injection if filter fails.
 */

const IG_API_PATTERNS = [
    "*://www.instagram.com/graphql/*",
    "*://www.instagram.com/api/graphql",
    "*://www.instagram.com/api/graphql?*",
    "*://www.instagram.com/api/graphql/*",
    "*://www.instagram.com/api/v1/media/*/info/",
    "*://www.instagram.com/api/v1/feed/*",
    "*://www.instagram.com/api/v1/clips/*",
    "*://www.instagram.com/api/v1/discover/*",
    "*://www.instagram.com/api/v1/reels/*"
];

function listenerInstagramApiFilter(details) {
    const url = details.url;

    if (isOwnRequest(url)) return {};

    log("IG-FILTER", `>>> onBeforeRequest fired`, {
        url: url.slice(0, 120),
        requestId: details.requestId,
        tabId: details.tabId,
        type: details.type
    });

    // Create the filter SYNCHRONOUSLY — before any async work
    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("IG-FILTER", `Failed to create filter`, { error: e.message, requestId: details.requestId });
        return {};
    }

    log("IG-FILTER", `Filter created for requestId ${details.requestId}`);

    const chunks = [];

    filter.ondata = (event) => {
        chunks.push(new Uint8Array(event.data));
        filter.write(event.data);  // Pass through unmodified
    };

    filter.onstop = () => {
        filter.close();

        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        log("IG-FILTER", `Response complete`, {
            requestId: details.requestId,
            totalBytes: total,
            chunks: chunks.length,
            url: url.slice(0, 80)
        });

        if (total === 0) {
            log("IG-FILTER", `Empty response, skipping`);
            return;
        }

        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }

        let str = new TextDecoder("utf-8").decode(combined);

        // Strip Instagram's "for (;;);" anti-hijacking prefix
        if (str.startsWith("for (;;);")) {
            str = str.slice(9);
            log("IG-FILTER", `Stripped anti-hijacking prefix`);
        }

        log("IG-FILTER", `Decoded body`, {
            length: str.length,
            preview: str.slice(0, 150),
            requestId: details.requestId
        });

        const parsed = tryParseJson(str);
        if (!parsed) {
            log("IG-FILTER", `JSON parse failed`, { firstChars: str.slice(0, 80) });
            return;
        }

        const topKeys = Object.keys(parsed);
        log("IG-FILTER", `Parsed OK`, { keys: topKeys.join(", "), url: url.slice(0, 80) });

        // Process in a microtask to avoid blocking
        Promise.resolve().then(() => processFilteredInstagramResponse(details, url, parsed));
    };

    filter.onerror = () => {
        log("IG-FILTER", `Filter error`, { error: filter.error, requestId: details.requestId });
        try { filter.close(); } catch (e) {}
    };

    return {};
}

function processFilteredInstagramResponse(details, url, parsed) {
    // Ensure we have a tabId
    ensureTabId(details);

    if (url.includes("graphql")) {
        log("IG-FILTER", `Routing: graphql`, {
            dataKeys: parsed.data ? Object.keys(parsed.data).join(", ") : "none",
            hasShortcodeMedia: !!parsed.data?.xdt_shortcode_media,
            hasTimeline: !!parsed.data?.user?.edge_owner_to_timeline_media,
            hasPrefetch: !!parsed.extensions?.all_video_dash_prefetch_representations
        });

        // Shortcode media or timeline (old GraphQL shape)
        if (parsed.data?.xdt_shortcode_media || parsed.data?.user?.edge_owner_to_timeline_media) {
            parseInstagramQuery(details, parsed);
            return;
        }

        // Scan all data keys for feed items (xdt_api__v1__feed, clips, etc.)
        // Skip prefetch — the actual video_versions are already in the feed edges
        if (parsed.data) {
            let found = 0;
            for (const [key, value] of Object.entries(parsed.data)) {
                if (!value || typeof value !== "object") continue;

                // Connection edges
                if (value.edges && Array.isArray(value.edges)) {
                    for (const edge of value.edges) {
                        // Unwrap the media from various nesting patterns:
                        // - Profile timeline: edge.node directly IS the media
                        // - Home timeline: edge.node.media, edge.node.explore_story.media
                        // - Stories/reels: edge.node is a reel container with .items[]
                        const candidates = [
                            edge.node?.media,
                            edge.node?.explore_story?.media,
                            edge.node
                        ];

                        for (const node of candidates) {
                            if (!node) continue;

                            // Direct video on the node
                            if (node.video_versions || node.media_type === 2 || node.video_url || node.carousel_media) {
                                sendInstagramItem(details, node);
                                found++;
                                break; // Don't double-count the same edge
                            }
                        }

                        // Stories/reels: edge.node.items[] contains the actual media
                        const reelNode = edge.node;
                        if (reelNode && Array.isArray(reelNode.items)) {
                            for (const item of reelNode.items) {
                                if (item && (item.video_versions || item.media_type === 2 || item.carousel_media)) {
                                    sendInstagramItem(details, item);
                                    found++;
                                }
                            }
                        }
                    }
                }

                // Direct items array
                if (value.items && Array.isArray(value.items)) {
                    for (const item of value.items) {
                        if (item && (item.video_versions || item.media_type === 2 || item.carousel_media)) {
                            sendInstagramItem(details, item);
                            found++;
                        }
                    }
                }

                // Single media wrapper
                if (value.media && typeof value.media === "object" && !Array.isArray(value.media)) {
                    const m = value.media;
                    if (m.video_versions || m.media_type === 2 || m.video_url) {
                        sendInstagramItem(details, m);
                        found++;
                    }
                }

                // Direct video object
                if (value.video_versions || (value.media_type === 2 && value.code)) {
                    sendInstagramItem(details, value);
                    found++;
                }
            }
            if (found > 0) {
                log("IG-FILTER", `GraphQL feed: sent ${found} video(s)`, { url: url.slice(0, 80) });
            }
        }
    } else if (url.includes("/api/v1/media") && url.includes("/info")) {
        const item = parsed?.items?.[0];
        if (item?.video_versions || item?.carousel_media) {
            sendInstagramItem(details, item);
            log("IG-FILTER", `Media info: sent`, { code: item.code });
        }
    } else if (url.includes("/api/v1/")) {
        // Feed endpoints
        processInstagramFeedItems(details, parsed, url);
    }
}

function processInstagramFeedItems(details, parsed, url) {
    let found = 0;

    if (Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
            if (item && (item.video_versions || item.media_type === 2 || item.carousel_media)) {
                sendInstagramItem(details, item);
                found++;
            }
        }
    }

    if (Array.isArray(parsed.feed_items)) {
        for (const fi of parsed.feed_items) {
            const item = fi.media_or_ad;
            if (item && (item.video_versions || item.media_type === 2 || item.carousel_media)) {
                sendInstagramItem(details, item);
                found++;
            }
        }
    }

    if (Array.isArray(parsed.reels_media)) {
        for (const reel of parsed.reels_media) {
            if (Array.isArray(reel.items)) {
                for (const item of reel.items) {
                    if (item && (item.video_versions || item.media_type === 2)) {
                        sendInstagramItem(details, item);
                        found++;
                    }
                }
            }
        }
    }

    if (parsed.reels && typeof parsed.reels === "object" && !Array.isArray(parsed.reels)) {
        for (const reel of Object.values(parsed.reels)) {
            if (Array.isArray(reel.items)) {
                for (const item of reel.items) {
                    if (item && (item.video_versions || item.media_type === 2)) {
                        sendInstagramItem(details, item);
                        found++;
                    }
                }
            }
        }
    }

    if (Array.isArray(parsed.sectional_items)) {
        for (const section of parsed.sectional_items) {
            for (const m of (section.layout_content?.medias || [])) {
                if (m.media && (m.media.video_versions || m.media.media_type === 2 || m.media.carousel_media)) {
                    sendInstagramItem(details, m.media); found++;
                }
            }
            for (const m of (section.layout_content?.fill_items || [])) {
                if (m.media && (m.media.video_versions || m.media.media_type === 2 || m.media.carousel_media)) {
                    sendInstagramItem(details, m.media); found++;
                }
            }
        }
    }

    if (Array.isArray(parsed.media_info_list)) {
        for (const item of parsed.media_info_list) {
            if (item && (item.video_versions || item.media_type === 2)) {
                sendInstagramItem(details, item); found++;
            }
        }
    }

    if (found > 0) {
        log("IG-FILTER", `Feed: sent ${found} video(s)`, { url: url.slice(0, 80) });
    }
}

// Content script message handler (fallback if filterResponseData fails)
browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type !== "instagram_intercept") return;

    const { payload } = message;
    if (!payload?.items?.length) return;

    const tabId = sender.tab?.id ?? -1;
    const details = {
        tabId,
        _resolvedTabId: tabId >= 0 ? tabId : undefined,
        url: payload.url || sender.tab?.url || "",
        requestId: `cs-${Date.now()}`
    };

    log("IG-CS", `Received ${payload.items.length} item(s) from content script`, {
        source: payload.source,
        url: payload.url?.slice(0, 80),
        tabId,
        types: payload.items.map(i => i.type).join(", ")
    });

    for (const item of payload.items) {
        try {
            processContentScriptItem(details, item);
        } catch (e) {
            log("IG-CS", `Error processing item`, { type: item.type, error: e.message });
        }
    }
});

function processContentScriptItem(details, item) {
    const { type, data } = item;
    if (!data) return;

    if (type === "shortcode_media") {
        parseInstagramQuery(details, { data: { xdt_shortcode_media: data } });
    } else if (type === "timeline_node") {
        if (data.video_url) {
            const code = data.shortcode;
            sendVariants(details, {
                variants: [{ url: data.video_url, width: data.dimensions?.width || 0, height: data.dimensions?.height || 0 }],
                origin: `https://www.instagram.com/p/${code}`,
                description: data.edge_media_to_caption?.edges?.[0]?.node?.text || "",
                img: data.display_url || null,
                name: data.owner?.username || null,
                duration: Math.round((data.video_duration || 0) * 1000)
            });
        }
    } else if (type === "prefetch" && data.video_id) {
        fetchInstagramByMediaId(details, data.video_id, null);
    } else if (data.video_versions || data.carousel_media || data.media_type === 2) {
        sendInstagramItem(details, data);
    }
}

// ---- Page navigation listener ----

function listenerInstagramPage(details) {
    if (details.type !== "main_frame") return;

    const url = details.url;
    if (details.tabId >= 0) cacheTabUrl(url, details.tabId);

    const match = url.match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
    if (match?.[1]) {
        log("IG-PAGE", `Shortcode found`, { shortcode: match[1] });
        fetchInstagramByShortcode(details, match[1]);
    }
}

// ---- Listener registrations ----

// filterResponseData on Instagram API — intercepts response inline
browser.webRequest.onBeforeRequest.addListener(
    listenerInstagramApiFilter,
    { urls: IG_API_PATTERNS, types: ["xmlhttprequest"] },
    ["blocking"]
);

// Page navigations (main_frame)
browser.webRequest.onBeforeRequest.addListener(
    listenerInstagramPage,
    { urls: [
        "*://www.instagram.com/reel/*",
        "*://www.instagram.com/p/*",
        "*://www.instagram.com/*/reel/*",
        "*://www.instagram.com/*/p/*"
    ], types: ["main_frame"] },
    []
);

// ============================================================================
// Instagram — cookie change handler (process queued requests)
// ============================================================================

browser.cookies.onChanged.addListener(async (changeInfo) => {
    if (!changeInfo.cookie.domain.includes("instagram.com")) return;

    await browser.storage.local.remove(COOKIE_CACHE_KEY);

    if (changeInfo.removed || instagramQueue.size === 0) return;

    log("COOKIES", `Processing ${instagramQueue.size} queued request(s)`);
    const cookieString = await getInstagramCookies();
    if (!cookieString) return;

    for (const [shortcode, queuedDetails] of instagramQueue) {
        if (!pendingShortcodes.has(shortcode)) {
            fetchInstagramByShortcode(queuedDetails, shortcode);
        } else {
            log("COOKIES", `Skipping queued ${shortcode}, already in flight`);
        }
    }
    instagramQueue.clear();
});

// ============================================================================
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

// SPA-navigation fallback: items the content script scrapes from the DOM.
browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "threads_intercept") return;

    const items = message.payload?.items;
    if (!Array.isArray(items) || items.length === 0) return;

    const tabId = sender.tab?.id ?? -1;
    const details = {
        tabId,
        _resolvedTabId: tabId >= 0 ? tabId : undefined,
        url: message.payload.url || sender.tab?.url || "",
        requestId: `threads-cs-${Date.now()}`
    };

    log("THREADS", `received ${items.length} item(s) from content script`, {
        url: message.payload.url?.slice(0, 100),
        tabId
    });

    for (const entry of items) {
        if (!entry?.item || !entry.origin) continue;
        try {
            sendInstagramItem(details, entry.item, entry.origin);
        } catch (e) {
            log("THREADS", `error processing item`, { origin: entry.origin, error: e.message });
        }
    }
});

// ============================================================================
// Rumble
// ----------------------------------------------------------------------------
// A Rumble watch page loads its player data from an embedJS endpoint:
//   rumble.com/embedJS/u3/?request=video&ver=2&v=<id>…  → JSON
// That JSON carries everything we need: title, author.name, duration (seconds),
// thumbnail (`i`), the watch permalink (`l`), and — crucially — a clean HLS
// master playlist at `ua.hls.auto.url` (== `u.hls.url`),
// e.g. https://rumble.com/hls-vod/<id>/playlist.m3u8. We emit that master as a
// single `media` URL (like the Twitch path); VariantProcessor/ffmpeg expands it
// into selectable qualities. The per-quality `ua.tar` entries are Rumble's
// video-only tarred HLS chunklists (separate `ua.audio`) accessed by byte
// range — not muxed, awkward to download standalone — so we don't use them.
//
// The matching `rumble.com/hls-vod/.*\.m3u8` block in webrequests/regex.js
// keeps the generic catcher from also grabbing that master (no duplicate).
// ============================================================================

const RUMBLE_EMBED_PATTERNS = [
    "*://rumble.com/embedJS/*",
    "*://*.rumble.com/embedJS/*"
];

// Shared emit: hand Rumble's HLS master to the Java M3U8 parser, which
// enumerates resolution-labelled qualities (text-only, no ffmpeg probe) — the
// same path as niconico/Twitch/Kick. enumerateMasterNative does its own origin
// dedup, so don't pre-mark here. Referer is set so the native OkHttp fetch of
// the master isn't rejected; on any fetch failure processHlsMaster falls back
// to the ffmpeg probe of the master (the previous behaviour).
async function emitRumbleHls(details, { hls, origin, title, author, thumb, durationSec }) {
    if (!hls || !origin) return;
    log("RUMBLE", "emitting HLS master", { origin, title, hls: hls.slice(0, 80) });
    enumerateMasterNative(details, {
        url: hls,
        origin,
        name: author,
        description: title,
        img: thumb,
        duration: durationSec > 0 ? Math.round(durationSec * 1000) : 0,
        requestHeaders: [{ name: "Referer", value: "https://rumble.com/" }]
    });
}

// Buffer a Rumble response body and hand the decoded text to onText. Shared by
// the JSON listeners (embedJS, service.php) and the shorts-page HTML reader.
function filterRumbleText(details, label, onText) {
    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("RUMBLE", `${label} filter create failed`, { error: e.message });
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
        if (total === 0) { log("RUMBLE", `${label} 0 bytes`); return; }
        const buf = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
        Promise.resolve().then(() => onText(new TextDecoder("utf-8").decode(buf)));
    };
    filter.onerror = () => { try { filter.close(); } catch (_) {} };
}

// Parse a Rumble JSON response and hand it to onParsed.
function filterRumbleJson(details, label, onParsed) {
    filterRumbleText(details, label, (text) => {
        const parsed = tryParseJson(text);
        if (!parsed) { log("RUMBLE", `${label} not JSON`, { bytes: text.length }); return; }
        onParsed(parsed);
    });
}

// Rumble watch embedJS carries progressive MP4 renditions (keyed by height)
// alongside the HLS auto master. The MP4 set is the FALLBACK now (preferred path
// is the HLS master via M3U8Parser): the MP4 group often omits height, giving
// unlabelled variants, so we only use it when there's no HLS master.
function collectRumbleMp4(group) {
    const out = [];
    const mp4 = group && group.mp4;
    if (!mp4) return out;
    const entries = Array.isArray(mp4)
        ? mp4.map((e) => [null, e])
        : (typeof mp4 === "object" ? Object.entries(mp4) : []);
    for (const [key, e] of entries) {
        const url = typeof e === "string" ? e : (e && e.url);
        if (typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
        const height = parseInt(key, 10) || e?.meta?.h || e?.h || e?.res || e?.resolution || e?.height || 0;
        let width = e?.meta?.w || e?.w || e?.width || 0;
        if (!width && height) width = Math.round(height * 16 / 9); // 16:9 estimate, label only
        out.push({ url, width, height, videoCodec: "h264" });
    }
    return out;
}

// Watch page: embedJS request=video carries one focal video.
function emitRumbleVideo(details, parsed) {
    const origin = parsed.l ? `https://rumble.com${parsed.l}`
        : (details.documentUrl || details.originUrl || details.url);
    const thumb = parsed.i || (Array.isArray(parsed.t) && parsed.t[0]?.i) || undefined;

    // Prefer the HLS master: the Java M3U8 parser enumerates resolution-labelled
    // qualities, whereas Rumble's progressive MP4 set frequently omits height →
    // unlabelled ("empty") variant rows.
    const hls = parsed?.ua?.hls?.auto?.url || parsed?.u?.hls?.url || parsed?.ua?.hls?.url;
    if (hls) {
        emitRumbleHls(details, {
            hls, origin, title: parsed.title, author: parsed.author?.name,
            thumb, durationSec: parsed.duration
        });
        return;
    }

    // Fallback: no HLS master — use the structured MP4 qualities (no ffprobe).
    // Dedup by URL.
    const seen = new Set();
    const variants = [];
    for (const v of [...collectRumbleMp4(parsed.ua), ...collectRumbleMp4(parsed.u)]) {
        if (seen.has(v.url)) continue;
        seen.add(v.url);
        variants.push(v);
    }
    if (variants.length > 0) {
        log("RUMBLE", `emitting ${variants.length} mp4 variant(s) (no HLS)`, { origin, title: parsed.title });
        sendVariants(details, {
            variants,
            origin,
            description: parsed.title,
            name: parsed.author?.name,
            img: thumb,
            duration: parsed.duration ? parsed.duration * 1000 : 0,
            skipProbe: true
        });
        return;
    }
    log("RUMBLE", "embedJS had no HLS master or MP4 set");
}

function listenerRumbleEmbed(details) {
    if (isOwnRequest(details.url)) return {};
    if (!details.url.includes("request=video")) return {};
    log("RUMBLE", "embedJS request intercepted", { url: details.url.slice(0, 100), tabId: details.tabId });
    filterRumbleJson(details, "embedJS", (parsed) => emitRumbleVideo(details, parsed));
    return {};
}

// Shorts feed: rumble.com/service.php?name=shorts.feed&offset=&limit=… returns
// a paginated list of shorts (video.full shape) as you scroll. Each item has
// its OWN title / by.name / thumb / duration and an HLS playlist under
// `videos[]`, so emitting per item gives correct per-short metadata — the
// generic catcher would otherwise tag every short with the stale SPA page
// title ("all shorts share one title"). We iterate the top-level feed list
// only and do NOT recurse into an item's related_video sub-list (the request
// asks for options=video.full,video.related_video).
// Emit one shorts.feed item. Prefer an HLS playlist (M3U8Parser, no ffprobe);
// shorts usually ship only direct MP4 variants in `videos[]` (type "mp4" with a
// `res`/`resolution` height), so those are the fallback — sent skipProbe with a
// 16:9 width estimate so the quality rows are labelled without a probe.
function emitRumbleFeedItem(details, item) {
    if (!item || !item.title) return false;
    const origin = item.url
        || (item.relative_url ? `https://rumble.com${item.relative_url}` : null);
    if (!origin) return false;

    const vids = Array.isArray(item.videos) ? item.videos : [];
    const mp4s = [];
    let hls = null;
    for (const v of vids) {
        if (!v || typeof v.url !== "string") continue;
        if (v.type === "hls" || /\.m3u8(?:[?#]|$)/.test(v.url)) {
            hls = hls || v.url;
        } else if (v.type === "mp4" || /\.mp4(?:[?#]|$)/.test(v.url)) {
            const height = v.res || v.resolution || 0;
            // width is label-only; estimate 16:9 when the feed omits it so the
            // quality row isn't blank (JsonHelper needs both w & h for a label).
            mp4s.push({
                url: v.url,
                height,
                width: height ? Math.round(height * 16 / 9) : 0,
                videoCodec: "h264"
            });
        }
    }

    // Prefer the HLS master (M3U8Parser → resolution-labelled, no ffprobe),
    // matching the watch page. Only fall back to the direct MP4 set when the
    // item ships no HLS playlist (common for shorts).
    if (hls) {
        emitRumbleHls(details, {
            hls, origin, title: item.title, author: item.by?.name,
            thumb: item.thumb, durationSec: item.duration
        });
        return true;
    }
    if (mp4s.length > 0) {
        // skipProbe: don't metadatareader-probe every feed item (it opened each
        // rumble.cloud mp4 just to read a resolution we already have from `res`).
        sendVariants(details, {
            variants: mp4s,
            origin,
            description: item.title,
            img: item.thumb,
            name: item.by?.name,
            duration: (item.duration || 0) * 1000,
            skipProbe: true
        });
        return true;
    }
    return false;
}

// Locate the feed list across the shapes we've seen:
//   service.php?name=shorts.feed → data.items[]
//   shorts page inline <rum-shorts> blob → items[] (top level)
//   watch-page video.full feed → data.videos[]
function rumbleFeedList(parsed) {
    if (Array.isArray(parsed?.data?.items)) return parsed.data.items;
    if (Array.isArray(parsed?.items)) return parsed.items;
    if (Array.isArray(parsed?.data?.videos)) return parsed.data.videos;
    return [];
}

function emitRumbleShortsFeed(details, parsed, label) {
    const list = rumbleFeedList(parsed);
    if (list.length === 0) return;
    let emitted = 0;
    for (const item of list) {
        if (emitRumbleFeedItem(details, item)) emitted++;
    }
    log("RUMBLE", `${label}: ${emitted}/${list.length} item(s) emitted`);
}

function listenerRumbleService(details) {
    if (isOwnRequest(details.url)) return {};
    // Only the shorts feed. The watch-page autoplay/related list uses the same
    // service.php endpoint; scoping to name=shorts.feed keeps us from emitting
    // a page's whole up-next lineup.
    if (!details.url.includes("name=shorts.feed")) return {};
    log("RUMBLE", "shorts.feed intercepted", { url: details.url.slice(0, 120), tabId: details.tabId });
    filterRumbleJson(details, "shorts.feed", (parsed) => emitRumbleShortsFeed(details, parsed, "shorts.feed"));
    return {};
}

// First short on a /shorts/ landing isn't fetched via service.php (the feed
// starts at offset>0) — it's embedded in the page HTML inside a <rum-shorts>
// element's <script type="application/json"> island ({items:[…]}, same item
// shape). Read it from the main_frame response (network-level, like Threads).
const RUMBLE_JSON_SCRIPT_RE = /<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;

function listenerRumbleShortsPage(details) {
    if (details.type !== "main_frame") return;
    if (details.tabId >= 0) cacheTabUrl(details.url, details.tabId);
    log("RUMBLE", "shorts page intercepted", { url: details.url.slice(0, 100), tabId: details.tabId });
    filterRumbleText(details, "shorts page", (html) => {
        let m;
        RUMBLE_JSON_SCRIPT_RE.lastIndex = 0;
        while ((m = RUMBLE_JSON_SCRIPT_RE.exec(html)) !== null) {
            const parsed = tryParseJson(m[1]);
            if (parsed && rumbleFeedList(parsed).length > 0) {
                emitRumbleShortsFeed(details, parsed, "shorts page");
            }
        }
    });
}

browser.webRequest.onBeforeRequest.addListener(
    listenerRumbleEmbed,
    { urls: RUMBLE_EMBED_PATTERNS, types: ["xmlhttprequest"] },
    ["blocking"]
);

browser.webRequest.onBeforeRequest.addListener(
    listenerRumbleService,
    { urls: ["*://rumble.com/service.php*"], types: ["xmlhttprequest"] },
    ["blocking"]
);

browser.webRequest.onBeforeRequest.addListener(
    listenerRumbleShortsPage,
    { urls: ["*://rumble.com/shorts/*"], types: ["main_frame"] },
    ["blocking"]
);

// ============================================================================
// Bilibili.tv (international / bstation)
// ----------------------------------------------------------------------------
// The play page SSR-inlines the playurl into window.__initialState (a devalue
// IIFE the page evaluates), and fires no separate playurl XHR — so a page-world
// content script (bilibili-tv-content.js + bilibili-tv-inject.js) reads
// player.playUrl.dash.{video[],audio[]} directly and posts the video+audio DASH
// baseUrls here. Each rep's baseUrl is ONE complete .m4s track (DASH
// SegmentBase, byte-range accessed) — not a segment list — so emitting
// {url: video, audioUrl: audio} routes to FFmpegMergeStrategy, which muxes the
// two whole-track files natively (FFmpegOkhttp does the range fetches). No
// ffmpeg.wasm. Referer https://www.bilibili.tv/ is required by the upos/
// bilivideo CDN; segments are .m4s which the generic catcher already drops, and
// the regex.js block reinforces it for the emitted baseUrls.
// ============================================================================

browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.kind !== "bilibili-tv-streams") return;
    const p = message.payload;
    if (!p || !Array.isArray(p.variants) || p.variants.length === 0) return;

    const tabId = sender.tab?.id ?? -1;
    const details = {
        tabId,
        _resolvedTabId: tabId >= 0 ? tabId : undefined,
        url: p.origin || sender.tab?.url || "",
        requestId: `bilibili-tv-${Date.now()}`
    };

    // The upos/bilivideo CDN truncates without a Referer; attach the site one.
    const requestHeaders = [{ name: "Referer", value: "https://www.bilibili.tv/" }];

    log("BILIBILI-TV", `received ${p.variants.length} variant(s)`, {
        title: p.title, origin: (p.origin || "").slice(0, 80), tabId
    });

    sendVariants(details, {
        variants: p.variants,
        origin: p.origin,
        description: p.title,
        name: p.title,
        img: p.img,
        duration: p.durationMs > 0 ? p.durationMs : 0,
        requestHeaders
    });
});

// ============================================================================
// Niconico (nicovideo.jp)
// ----------------------------------------------------------------------------
// Two passive response filters, no request replay / signing on our side:
//   1. www.nicovideo.jp/api/watch/v3_guest/<id> (or /v3/) — the watch metadata.
//      Cache title / duration / thumbnail keyed by video id.
//   2. nvapi.nicovideo.jp/v1/watch/<id>/access-rights/hls (POST, 201) — the
//      player mints the playable stream here; the response carries
//      data.contentUrl: a CloudFront-signed (self-authorizing) AES-128 HLS
//      master on delivery.domand. Emit it as a single `media` URL →
//      FFmpegMuxStrategy, which (via FFmpegOkhttp) fetches the signed media
//      playlists, encrypted .cmfv/.cmfa segments and AES .key and muxes. No
//      Referer needed — the URL signature is the auth.
// The regex.js block on delivery.domand .m3u8 keeps the generic catcher from
// also grabbing the bare master.
// ============================================================================

const NICO_META_TTL = 5 * 60 * 1000;
const nicoMeta = new Map(); // videoId -> { title, durationMs, img, ts }

function nicoCacheMeta(id, meta) {
    nicoMeta.set(id, { ...meta, ts: Date.now() });
    if (nicoMeta.size > 50) {
        const now = Date.now();
        for (const [k, v] of nicoMeta) { if (now - v.ts > NICO_META_TTL) nicoMeta.delete(k); }
    }
}
function nicoGetMeta(id) {
    const m = id && nicoMeta.get(id);
    if (!m) return null;
    if (Date.now() - m.ts > NICO_META_TTL) { nicoMeta.delete(id); return null; }
    return m;
}

function nicoFilterJson(details, label, onParsed) {
    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("NICO", `${label} filter create failed`, { error: e.message });
        return;
    }
    const chunks = [];
    filter.ondata = (event) => { chunks.push(new Uint8Array(event.data)); filter.write(event.data); };
    filter.onstop = () => {
        filter.close();
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        if (total === 0) { log("NICO", `${label}: 0 bytes`); return; }
        const buf = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
        const text = new TextDecoder("utf-8").decode(buf);
        const parsed = tryParseJson(text);
        if (!parsed) { log("NICO", `${label}: not JSON`, { bytes: total, head: text.slice(0, 100) }); return; }
        log("NICO", `${label}: parsed ${total} bytes`);
        Promise.resolve().then(() => onParsed(parsed));
    };
    filter.onerror = () => { log("NICO", `${label}: filter error`); try { filter.close(); } catch (_) {} };
}

function nicoIdFromWatchApi(url) {
    const m = url.match(/\/api\/watch\/v3(?:_guest)?\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
}
function nicoIdFromAccess(url) {
    const m = url.match(/\/v1\/watch\/([A-Za-z0-9]+)\/access-rights/);
    return m ? m[1] : null;
}

function listenerNicoWatchApi(details) {
    if (isOwnRequest(details.url)) return {};
    const id = nicoIdFromWatchApi(details.url);
    log("NICO", "watch-api hit", { url: details.url.slice(0, 120), id, type: details.type });
    if (!id) return {};
    nicoFilterJson(details, "watch-api", (parsed) => {
        const v = parsed?.data?.video || {};
        const thumb = v.thumbnail || {};
        nicoCacheMeta(id, {
            title: v.title || null,
            durationMs: typeof v.duration === "number" ? v.duration * 1000 : 0,
            img: thumb.largeUrl || thumb.url || thumb.middleUrl || undefined
        });
        log("NICO", "cached metadata", { id, title: v.title });
    });
    return {};
}

// Hand the niconico signed master to native for OkHttp fetch + Java enumeration.
// Builds the headers domand validates (Origin/Referer + the domand cookie).
async function emitNicoMaster(details, id, contentUrl) {
    const origin = details.documentUrl || details.originUrl
        || (id ? `https://www.nicovideo.jp/watch/${id}` : details.url);
    let pageOrigin = "https://www.nicovideo.jp";
    try { pageOrigin = new URL(origin).origin; } catch (e) {}
    const requestHeaders = [
        { name: "Origin", value: pageOrigin },
        { name: "Referer", value: pageOrigin + "/" }
    ];
    try {
        const cookies = await browser.cookies.getAll({ url: contentUrl });
        if (cookies && cookies.length) {
            requestHeaders.push({ name: "Cookie", value: cookies.map(c => `${c.name}=${c.value}`).join("; ") });
        }
    } catch (e) { log("NICO", "cookie read failed", { error: e.message }); }
    const meta = nicoGetMeta(id) || {};
    enumerateMasterNative(details, {
        url: contentUrl,
        origin,
        name: meta.title,
        description: meta.title,
        img: meta.img,
        duration: meta.durationMs,
        requestHeaders
    });
}

async function emitNicoStream(details, id, contentUrl) {
    const origin = details.documentUrl || details.originUrl
        || (id ? `https://www.nicovideo.jp/watch/${id}` : details.url);
    if (alreadySent(origin)) { log("NICO", "already sent", { origin }); return; }
    markSent(origin);

    const meta = nicoGetMeta(id) || {};
    const tabId = await resolveTabId(details);
    let incognito = false;
    if (tabId >= 0) {
        try { incognito = (await browser.tabs.get(tabId))?.incognito || false; } catch (e) {}
    }

    // delivery.domand validates Origin + a domand cookie on every fetch, so we
    // attach the page Origin/Referer and the content-host cookies. We emit the
    // signed master m3u8 as a single `media` entry (no per-quality splitting).
    // NB: the "endless probing / 720p hangs" bug is NOT a header problem — it's
    // the domand AES key being SINGLE-USE per session (fetched once by the
    // metadatareader probe, again by the downloader → the second fetch is a
    // garbage decoy → mov walks). The fix belongs in ffmpeg (cache/reuse the
    // key), not here — see the "Niconico domand AES key" section in CLAUDE.md.
    let pageOrigin = "https://www.nicovideo.jp";
    try { pageOrigin = new URL(origin).origin; } catch (e) {}
    const requestHeaders = [
        { name: "Origin", value: pageOrigin },
        { name: "Referer", value: pageOrigin + "/" }
    ];
    try {
        const cookies = await browser.cookies.getAll({ url: contentUrl });
        if (cookies && cookies.length) {
            requestHeaders.push({ name: "Cookie", value: cookies.map(c => `${c.name}=${c.value}`).join("; ") });
            log("NICO", `attached ${cookies.length} domand cookie(s)`);
        } else {
            log("NICO", "no domand cookies found for content host");
        }
    } catch (e) { log("NICO", "cookie read failed", { error: e.message }); }

    const message = { url: contentUrl, type: "media", origin, tabId, request: details.requestId, incognito, requestHeaders };
    if (meta.title) { message.description = meta.title; message.name = meta.title; }
    if (meta.img) message.img = meta.img;
    if (meta.durationMs > 0) message.duration = meta.durationMs;

    log("NICO", "emitting HLS master", { origin, title: meta.title, hls: contentUrl.slice(0, 80) });
    sendNative(message);
}

// ---- Enumerate renditions from the master playlist (no decryption, so no key
// burned at capture) and emit per-quality video+audio variants. The downloader
// then becomes the FIRST/only consumer of the single-use AES key, so the
// "shows in Capture, hangs on download" decoy path never happens.
//
// The parser can't fetch the master itself (delivery.domand validates Origin and
// JS can't set it), so we capture the PLAYER's own master fetch passively via
// filterResponseData — the same technique used for the watch/access-rights
// responses. access-rights records the master URL as pending; listenerNicoMaster
// matches the player's fetch of it and parses the m3u8. If the master is never
// seen (timeout), we fall back to the single-master emit so capture still works.

const nicoPendingMaster = new Map(); // masterPathNoQuery -> { id, details, contentUrl, ts }
const NICO_MASTER_TTL = 8000;

// Passive text-body filter (m3u8 isn't JSON, so nicoFilterJson can't be reused).
function nicoFilterText(details, label, onText) {
    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("NICO", `${label} filter create failed`, { error: e.message });
        return;
    }
    const chunks = [];
    filter.ondata = (event) => { chunks.push(new Uint8Array(event.data)); filter.write(event.data); };
    filter.onstop = () => {
        filter.close();
        const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
        if (total === 0) { log("NICO", `${label}: 0 bytes`); return; }
        const buf = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
        Promise.resolve().then(() => onText(new TextDecoder("utf-8").decode(buf)));
    };
    filter.onerror = () => { log("NICO", `${label}: filter error`); try { filter.close(); } catch (_) {} };
}

// Parse a domand master m3u8 → { audios:{groupId:url}, videos:[{url,width,height,audioGroup}] }.
function parseNicoMaster(text) {
    const lines = text.split(/\r?\n/);
    const audios = {};
    const videos = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO/.test(line)) {
            const gid = (line.match(/GROUP-ID="([^"]+)"/) || [])[1];
            const uri = (line.match(/URI="([^"]+)"/) || [])[1];
            if (gid && uri) audios[gid] = uri;
        } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
            const res = line.match(/RESOLUTION=(\d+)x(\d+)/) || [];
            const audioGroup = (line.match(/AUDIO="([^"]+)"/) || [])[1] || null;
            const url = (lines[i + 1] || "").trim();
            if (url && /^https?:\/\//.test(url)) {
                videos.push({
                    url,
                    width: parseInt(res[1], 10) || 0,
                    height: parseInt(res[2], 10) || 0,
                    audioGroup
                });
            }
        }
    }
    return { audios, videos };
}

// Highest-bitrate audio URL from the EXT-X-MEDIA groups (192kbps > 64kbps).
function bestNicoAudio(audios) {
    let best = null;
    let bestKbps = -1;
    for (const gid of Object.keys(audios)) {
        const kb = parseInt((gid.match(/(\d+)kbps/) || [])[1] || "0", 10);
        if (kb > bestKbps) { bestKbps = kb; best = audios[gid]; }
    }
    return best;
}

// Returns true if it emitted variants, false if the master had nothing usable
// (caller then falls back to the single-master emit).
async function emitNicoVariants(details, id, masterText) {
    const origin = details.documentUrl || details.originUrl
        || (id ? `https://www.nicovideo.jp/watch/${id}` : details.url);
    if (alreadySent(origin)) { log("NICO", "variants already sent", { origin }); return true; }

    const { audios, videos } = parseNicoMaster(masterText);
    const audioUrl = bestNicoAudio(audios);
    if (!videos.length || !audioUrl) {
        log("NICO", "master parse yielded no variants");
        return false;
    }

    // One variant per unique video rendition, paired with the best audio.
    const seen = new Set();
    const variants = [];
    for (const v of videos) {
        if (seen.has(v.url)) continue;
        seen.add(v.url);
        variants.push({
            url: v.url,
            audioUrl,
            width: v.width,
            height: v.height,
            videoCodec: "h264",
            audioCodec: "aac"
        });
    }

    let pageOrigin = "https://www.nicovideo.jp";
    try { pageOrigin = new URL(origin).origin; } catch (e) {}
    const requestHeaders = [
        { name: "Origin", value: pageOrigin },
        { name: "Referer", value: pageOrigin + "/" }
    ];
    try {
        const cookies = await browser.cookies.getAll({ url: variants[0].url });
        if (cookies && cookies.length) {
            requestHeaders.push({ name: "Cookie", value: cookies.map(c => `${c.name}=${c.value}`).join("; ") });
        }
    } catch (e) { log("NICO", "cookie read failed", { error: e.message }); }

    const meta = nicoGetMeta(id) || {};
    log("NICO", `emitting ${variants.length} HLS variant(s)`, { origin, title: meta.title });
    sendVariants(details, {
        variants,
        origin,
        description: meta.title,
        name: meta.title,
        img: meta.img,
        duration: meta.durationMs,
        requestHeaders,
        skipProbe: true
    });
    return true;
}

function listenerNicoMaster(details) {
    if (isOwnRequest(details.url)) return {};
    const path = details.url.split("?")[0];
    const pending = nicoPendingMaster.get(path);
    if (!pending) return {};
    nicoPendingMaster.delete(path);
    log("NICO", "master hit", { path: path.slice(0, 90), id: pending.id });
    nicoFilterText(details, "master", (text) => {
        emitNicoVariants(pending.details, pending.id, text).then((ok) => {
            if (ok === false) emitNicoStream(pending.details, pending.id, pending.contentUrl);
        });
    });
    return {};
}

function listenerNicoAccessHls(details) {
    if (isOwnRequest(details.url)) return {};
    const id = nicoIdFromAccess(details.url);
    log("NICO", "access-hls hit", { url: details.url.slice(0, 120), id, method: details.method, type: details.type });
    nicoFilterJson(details, "access-hls", (parsed) => {
        const contentUrl = parsed?.data?.contentUrl;
        // The endpoint is hit twice: the &__retry=0 POST returns a 238-byte
        // "accept" envelope whose contentUrl is a bare query string
        // ("?accepted=true&data=…") — NOT a playable URL — while the real POST
        // (201) returns the absolute https://delivery.domand…m3u8 master.
        // Require an absolute http(s) URL so we ignore the accept envelope and
        // don't mark-sent on it (which would dedup-block the real one).
        if (!contentUrl || !/^https?:\/\//i.test(contentUrl)) {
            log("NICO", "access-hls: no usable contentUrl", {
                status: parsed?.meta?.status,
                contentUrl: contentUrl ? String(contentUrl).slice(0, 40) : null
            });
            return;
        }
        // Hand the signed master to native: Java OkHttp-fetches it (with the
        // Origin/Referer/Cookie domand validates) and M3U8Parser enumerates the
        // per-quality variants — no ffmpeg probe, so the single-use key is never
        // burned at capture. Java falls back to a media capture if it can't parse.
        emitNicoMaster(details, id, contentUrl);
    });
    return {};
}

browser.webRequest.onBeforeRequest.addListener(
    listenerNicoWatchApi,
    { urls: ["*://www.nicovideo.jp/api/watch/v3_guest/*", "*://www.nicovideo.jp/api/watch/v3/*"], types: ["xmlhttprequest"] },
    ["blocking"]
);

browser.webRequest.onBeforeRequest.addListener(
    listenerNicoAccessHls,
    { urls: ["*://nvapi.nicovideo.jp/v1/watch/*/access-rights/hls*"], types: ["xmlhttprequest"] },
    ["blocking"]
);

// The player's fetch of the signed master playlist — captured passively so we
// can enumerate renditions without the parser making its own (Origin-blocked) fetch.
browser.webRequest.onBeforeRequest.addListener(
    listenerNicoMaster,
    { urls: ["*://delivery.domand.nicovideo.jp/*/playlists/variants/*.m3u8*"], types: ["xmlhttprequest", "media", "other"] },
    ["blocking"]
);

// ============================================================================
// Facebook
// ----------------------------------------------------------------------------
// Mirrors the Instagram pattern: filter the GraphQL response inline with
// filterResponseData, walk the JSON for video nodes, emit variants.
//
// Caveats worth knowing — Facebook is meaningfully harder than Instagram:
//   - Most videos are auth-walled. Logged-out users get gated responses that
//     either lack video fields or 302 to /login. The extraction still runs;
//     it just produces nothing, which is the right behaviour.
//   - GraphQL operation friendly_names rotate (CometSinglePostQuery,
//     VideoPlayerSubsequentResponsePayload, CometFocusedVideoContentQuery…).
//     Filtering by friendly_name would mean chasing renames; instead we
//     filter every /api/graphql/ response and let the video-node walker
//     decide. Cheap walk, harmless when there's no video.
//   - Responses are often newline-delimited JSON (streamed GraphQL).
//     Each line is a standalone JSON object — handle both NDJSON and
//     single-object shapes.
//   - Field names inside the video node change too. We check the union of
//     locations seen in the wild and treat absence as 'no video here'.
// ============================================================================

const FB_API_PATTERNS = [
    "*://www.facebook.com/api/graphql/*",
    "*://www.facebook.com/api/graphql"
];

const FB_VIDEO_URL_FIELDS = [
    "playable_url_quality_hd",
    "browser_native_hd_url",
    "playable_url",
    "browser_native_sd_url"
];

const FB_DASH_URL_FIELDS = [
    "playable_url_dash_hd",
    "playable_url_dash"
];

// Heuristic: does this object look like a Facebook video node? Any of the
// known URL fields being a non-empty string is enough — the field set has
// been stable across recent (~2 years) of GraphQL rotations even when other
// surrounding shape has changed.
function isFacebookVideoNode(obj) {
    if (!obj || typeof obj !== "object") return false;
    for (const f of FB_VIDEO_URL_FIELDS) {
        if (typeof obj[f] === "string" && obj[f].length > 0) return true;
    }
    for (const f of FB_DASH_URL_FIELDS) {
        if (typeof obj[f] === "string" && obj[f].length > 0) return true;
    }
    return false;
}

// Walk an arbitrary JSON tree collecting Facebook video nodes. Depth-capped
// and dedup'd by identity to keep cost bounded on News Feed payloads, which
// can be megabytes with deeply nested story_card / attachments / edges.
function collectFacebookVideos(root) {
    const out = [];
    const seen = new Set();
    const MAX_DEPTH = 12;
    const MAX_NODES = 5000;
    let visited = 0;

    function walk(node, depth) {
        if (visited++ > MAX_NODES) return;
        if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;
        if (seen.has(node)) return;
        seen.add(node);

        if (isFacebookVideoNode(node)) {
            out.push(node);
            // Keep walking — a video node can itself contain related videos
            // (e.g. CometVideoHomeRootQuery returns a list under data.video.related)
        }

        if (Array.isArray(node)) {
            for (const child of node) walk(child, depth + 1);
        } else {
            for (const key in node) walk(node[key], depth + 1);
        }
    }

    walk(root, 0);
    return out;
}

function parseFacebookVideoUrl(url) {
    if (!url) return null;
    // /watch/?v=VIDEOID or /watch?v=VIDEOID
    let m = url.match(/facebook\.com\/watch\/?\?v=(\d+)/);
    if (m) return { type: "watch", videoId: m[1] };
    // /{user}/videos/{id}/
    m = url.match(/facebook\.com\/(?:[A-Za-z0-9.]+\/)?videos\/(?:[A-Za-z0-9._-]+\/)?(\d+)/);
    if (m) return { type: "video", videoId: m[1] };
    // /reel/{id}
    m = url.match(/facebook\.com\/reel\/(\d+)/);
    if (m) return { type: "reel", videoId: m[1] };
    // fb.watch/{code}
    m = url.match(/fb\.watch\/([A-Za-z0-9_-]+)/);
    if (m) return { type: "fbwatch", code: m[1] };
    return null;
}

function canonicalFacebookOrigin(video, fallbackUrl) {
    const videoId = video?.id || video?.video_id || video?.videoId;
    if (videoId) return `https://www.facebook.com/watch/?v=${videoId}`;
    return fallbackUrl || "https://www.facebook.com/";
}

function extractFacebookOwnerName(video) {
    return video?.owner?.name
        || video?.owner?.username
        || video?.creation_story?.actors?.[0]?.name
        || video?.savable_title
        || null;
}

function extractFacebookThumbnail(video) {
    return video?.preferred_thumbnail?.image?.uri
        || video?.thumbnailImage?.uri
        || video?.image?.uri
        || video?.thumbnail?.uri
        || null;
}

function extractFacebookDescription(video) {
    return video?.savable_description?.text
        || video?.message?.text
        || video?.title?.text
        || "";
}

function sendFacebookVideo(details, video, pageUrl) {
    const variants = [];

    // Progressive variants — preferred when both HD and SD are present.
    // Mark explicit heights so sendVariants' descending sort puts HD first.
    const hdUrl = video.playable_url_quality_hd || video.browser_native_hd_url;
    const sdUrl = video.playable_url || video.browser_native_sd_url;
    if (typeof hdUrl === "string" && hdUrl.length > 0) {
        variants.push({ url: hdUrl, width: 0, height: 1080 });
    }
    if (typeof sdUrl === "string" && sdUrl.length > 0 && sdUrl !== hdUrl) {
        variants.push({ url: sdUrl, width: 0, height: 480 });
    }

    // DASH manifest fallback. The Kotlin side's FFmpeg path handles DASH
    // manifests natively — we treat the manifest URL as a single variant.
    if (variants.length === 0) {
        const dashUrl = video.playable_url_dash_hd || video.playable_url_dash;
        if (typeof dashUrl === "string" && dashUrl.length > 0) {
            variants.push({ url: dashUrl, width: 0, height: 0 });
        }
    }

    if (variants.length === 0) return false;

    const origin = canonicalFacebookOrigin(video, pageUrl);
    sendVariants(details, {
        variants,
        origin,
        description: extractFacebookDescription(video),
        img: extractFacebookThumbnail(video),
        name: extractFacebookOwnerName(video),
        duration: Math.round((video.playable_duration_in_ms
            || (video.length_in_second ? video.length_in_second * 1000 : 0)
            || 0))
    });
    return true;
}

function processFacebookGraphqlBody(details, url, body) {
    // Facebook sometimes prefixes its responses with for(;;); to defeat
    // JSONP-style hijacking — same as Instagram. Strip when present.
    let str = body;
    if (str.startsWith("for (;;);")) str = str.slice(9);

    // Streamed GraphQL: each line is an independent JSON object. We try the
    // whole body as a single parse first (covers single-shot responses);
    // if that fails, fall back to line-by-line.
    const candidates = [];
    const single = tryParseJson(str);
    if (single) {
        candidates.push(single);
    } else {
        for (const line of str.split(/\r?\n/)) {
            if (!line.trim()) continue;
            const obj = tryParseJson(line);
            if (obj) candidates.push(obj);
        }
    }

    if (candidates.length === 0) {
        log("FB-FILTER", `no JSON parsed from body`, { bytes: str.length, preview: str.slice(0, 80) });
        return;
    }

    let emitted = 0;
    for (const parsed of candidates) {
        const videos = collectFacebookVideos(parsed);
        for (const v of videos) {
            if (sendFacebookVideo(details, v, url)) emitted++;
        }
    }
    log("FB-FILTER", `processed ${candidates.length} chunk(s), emitted ${emitted} video(s)`, { url: url.slice(0, 80) });
}

function listenerFacebookApiFilter(details) {
    const url = details.url;
    if (isOwnRequest(url)) return {};

    let filter;
    try {
        filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (e) {
        log("FB-FILTER", `filter create failed`, { error: e.message });
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
        for (const c of chunks) { combined.set(c, offset); offset += c.byteLength; }
        const body = new TextDecoder("utf-8").decode(combined);
        Promise.resolve().then(() => processFacebookGraphqlBody(details, url, body));
    };
    filter.onerror = () => { try { filter.close(); } catch (_) {} };
    return {};
}

function checkAndProcessFacebookUrl(url, tabId) {
    if (!url) return;
    if (!url.includes("facebook.com") && !url.includes("fb.watch")) return;
    const parsed = parseFacebookVideoUrl(url);
    if (!parsed) return;
    // Facebook video extraction is response-driven (filter on GraphQL).
    // We only need the tabId cached so that when the GraphQL fires we
    // can resolve the originating tab — the actual emission happens
    // inside listenerFacebookApiFilter.
    log("FB-PAGE", `video page detected`, { parsed, url: url.slice(0, 80), tabId });
}

browser.webRequest.onBeforeRequest.addListener(
    listenerFacebookApiFilter,
    { urls: FB_API_PATTERNS, types: ["xmlhttprequest"] },
    ["blocking"]
);

// ============================================================================
// Startup
// ============================================================================

async function handleExistingTabs() {
    try {
        const tabs = await browser.tabs.query({});
        for (const tab of tabs) {
            if (tab.url && tab.id >= 0) {
                cacheTabUrl(tab.url, tab.id);
                checkAndProcessInstagramUrl(tab.url, tab.id);
                checkAndProcessFacebookUrl(tab.url, tab.id);
                checkAndProcessKickUrl(tab.url, tab.id);
                checkAndProcessTwitchUrl(tab.url, tab.id);
                checkAndProcessDailymotionUrl(tab.url, tab.id);
            }
        }
        log("INIT", `Cached ${urlToTabCache.size} URLs from ${tabs.length} existing tabs`);
    } catch (e) {
        log("INIT", `Error checking existing tabs`, e.message);
    }
}

function checkAndProcessInstagramUrl(url, tabId) {
    if (!url || !url.includes("instagram.com")) return;
    // Match both /reel/CODE, /p/CODE, and /username/reel/CODE (SPA navigation from profiles)
    const match = url.match(/instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reel|p)\/([A-Za-z0-9_-]+)/);
    if (match?.[1]) {
        log("IG-PAGE", `SPA navigation detected`, { shortcode: match[1], url: url.slice(0, 80), tabId });
        const details = { tabId, url, _resolvedTabId: tabId };
        fetchInstagramByShortcode(details, match[1]);
    }
}

function checkAndProcessKickUrl(url, tabId) {
    if (!url || !url.includes("kick.com")) return;
    const parsed = parseKickUrl(url);
    if (!parsed) return;

    log("KICK", `Tab URL detected`, { url: url.slice(0, 80), parsed });
    const details = { tabId, url, _resolvedTabId: tabId, requestId: `tab-${tabId}-${Date.now()}` };

    if (parsed.type === "channel") {
        fetchKickChannel(details, parsed.streamer);
    } else if (parsed.type === "clip" && parsed.clipId) {
        fetchKickClip(details, parsed.clipId);
    } else if (parsed.type === "video" && parsed.videoId) {
        fetchKickVideo(details, parsed.videoId);
    }
}

function checkAndProcessTwitchUrl(url, tabId) {
    if (!url || !url.includes("twitch.tv")) return;
    const parsed = parseTwitchUrl(url);
    if (!parsed) return;

    log("TWITCH", `Tab URL detected`, { url: url.slice(0, 80), parsed });
    const details = { tabId, url, _resolvedTabId: tabId, requestId: `tab-${tabId}-${Date.now()}` };

    if (parsed.type === "channel") {
        fetchTwitchLiveStream(details, parsed.login);
    } else if (parsed.type === "vod") {
        fetchTwitchVod(details, parsed.vodId);
    } else if (parsed.type === "clip") {
        fetchTwitchClip(details, parsed.slug);
    }
}

log("INIT", `Video parser extension loaded (Instagram, Facebook, Twitter/X, Vimeo, Kick, Twitch, Dailymotion)`);
handleExistingTabs();