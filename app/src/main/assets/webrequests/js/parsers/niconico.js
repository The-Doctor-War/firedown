// Niconico (nicovideo.jp) parser — split verbatim out of the former parser-background.js.
import { log, tryParseJson, isOwnRequest, alreadySent, markSent, sendNative, sendVariants, enumerateMasterNative, resolveTabId } from './common.js';

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
    const tabId = await resolveTabId(details);
    if (alreadySent(origin, tabId)) { log("NICO", "already sent", { origin, tabId }); return; }
    markSent(origin, tabId);

    const meta = nicoGetMeta(id) || {};
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
    const tabId = await resolveTabId(details);
    if (alreadySent(origin, tabId)) { log("NICO", "variants already sent", { origin, tabId }); return true; }

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
