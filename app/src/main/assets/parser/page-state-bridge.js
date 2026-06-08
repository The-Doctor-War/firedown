// page-state-bridge.js — ONE generic page-world → media bridge for ALL sites.
//
// Some sites SSR-inline the playable media (DASH video+audio reps) into a
// page-world JS global — window.__initialState (bilibili.tv, a devalue blob),
// __NEXT_DATA__, __NUXT__, a Redux store, … — and fire NO playurl XHR. So the
// wire (webRequest) never sees it and the DOM has no media element either; only
// page-world JS can read it. The old approach was a per-site content-script +
// page-world WAR inject pair (bilibili-tv-content.js + bilibili-tv-inject.js).
// This replaces that with a SINGLE catch-all content script, matched on
// <all_urls> (no per-site files, no per-site host permissions):
//
//   - It reads the page's real globals via Firefox's Xray **wrappedJSObject**
//     waiver — the same mechanism youtube/content.js and webrequests/
//     content-script.js already use in this GeckoView — so there is no <script>
//     inject, no web-accessible resource, and no page-CSP problem.
//   - It runs a bounded, generic structural search for a DASH {video[],audio[]}
//     slice, copies it to plain data (Xray-safe), builds video+audio variants,
//     and hands them to the background, which emits them via sendVariants →
//     native FFmpegMergeStrategy (whole-track .m4s mux, no ffmpeg.wasm).
//   - It ALSO reads a page-world JS player's RESOLVED source (JWPlayer
//     getPlaylist().file) for sites whose player fetches a (often obfuscated)
//     HLS master only on PLAY (preload:none) — the wire can't see it pre-play,
//     but the player must hold the de-obfuscated url to play, so we read it and
//     emit an hls-master. This is why it runs in subframes (all_frames): the
//     player is usually an embedded cross-origin iframe.
//
// Per-site logic that needs page-world DATA (e.g. bilibili.tv's ogv episode
// title/cover) is a host-keyed branch in `resolveMeta` HERE — this is the only
// place that holds the page-world `root`, which the background can't read.
// Per-site REQUEST/emit specifics stay in background.js. Either way: never a new
// injected file. Cheap on the ~all sites that have no such state: it probes a
// short list of known state globals by name and no-ops when none hold media.
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[PAGE-STATE]', ...args); };
    browser.runtime.sendNativeMessage("parser", { kind: "get-debug-flag" })
        .then(r => { DEBUG = r === true; }, () => {});

    // Globals sites inline their SSR/SPA page model into. Probed by name (cheap)
    // rather than walking all of window. Add names here, never per-site files.
    const STATE_GLOBALS = [
        "__initialState", "__INITIAL_STATE__", "__NUXT__", "__NEXT_DATA__",
        "__APOLLO_STATE__", "__PRELOADED_STATE__", "__REDUX_STATE__",
        "__data", "__STATE__"
    ];

    // ---- DASH shape detection (no array-callback methods — those misbehave on
    // Xray-waived page arrays, so everything here uses index loops / direct
    // reads, all wrapped defensively). ------------------------------------------
    function looksLikeRep(o) {
        return o && typeof o === "object"
            && (typeof o.baseUrl === "string" || typeof o.base_url === "string")
            && typeof o.bandwidth === "number";
    }

    function isDashShape(o) {
        if (!o || typeof o !== "object") return false;
        const v = o.video, a = o.audio;
        if (!v || !a) return false;
        let vlen, alen;
        try { vlen = v.length; alen = a.length; } catch (_) { return false; }
        if (typeof vlen !== "number" || typeof alen !== "number" || vlen === 0 || alen === 0) {
            return false;
        }
        let first;
        try { first = v[0]; } catch (_) { return false; }
        return looksLikeRep(first);
    }

    // Bounded structural search for a DASH object anywhere in a state tree.
    // depth + node caps so a huge / cyclic page model can't hang the page.
    function findDash(root) {
        const seen = new Set();
        let budget = 20000;
        let found = null;
        (function walk(o, depth) {
            if (found || !o || typeof o !== "object" || depth > 8 || budget-- <= 0) return;
            if (seen.has(o)) return;
            seen.add(o);
            if (isDashShape(o)) { found = o; return; }
            if (Array.isArray(o)) {
                let n;
                try { n = o.length; } catch (_) { return; }
                if (typeof n !== "number") return;
                for (let i = 0; i < n && !found; i++) {
                    let v;
                    try { v = o[i]; } catch (_) { continue; }
                    walk(v, depth + 1);
                }
                return;
            }
            let keys;
            try { keys = Object.keys(o); } catch (_) { return; }
            for (let i = 0; i < keys.length && !found; i++) {
                let v;
                try { v = o[keys[i]]; } catch (_) { continue; }
                walk(v, depth + 1);
            }
        })(root, 0);
        return found;
    }

    // ---- Xray-safe copy of the found DASH slice into plain data --------------
    function repToPlain(r) {
        if (!r || typeof r !== "object") return null;
        const baseUrl = (typeof r.baseUrl === "string") ? r.baseUrl
            : (typeof r.base_url === "string" ? r.base_url : null);
        if (!baseUrl) return null;
        let backupUrl;
        try {
            const b = r.backupUrl || r.backup_url;
            if (b && typeof b === "object" && typeof b.length === "number" && b.length) {
                if (typeof b[0] === "string") backupUrl = b[0];
            }
        } catch (_) {}
        return {
            baseUrl,
            backupUrl,
            bandwidth: typeof r.bandwidth === "number" ? r.bandwidth : 0,
            width: typeof r.width === "number" ? r.width : 0,
            height: typeof r.height === "number" ? r.height : 0,
            codecs: typeof r.codecs === "string" ? r.codecs : undefined
        };
    }

    function cloneRepArray(arr) {
        const out = [];
        let n;
        try { n = arr.length; } catch (_) { return out; }
        if (typeof n !== "number") return out;
        for (let i = 0; i < n && i < 200; i++) {
            let r;
            try { r = arr[i]; } catch (_) { continue; }
            const p = repToPlain(r);
            if (p) out.push(p);
        }
        return out;
    }

    function cloneDash(wDash) {
        const video = cloneRepArray(wDash.video);
        const audio = cloneRepArray(wDash.audio);
        let duration = 0;
        try { const d = Number(wDash.duration); if (d > 0) duration = d; } catch (_) {}
        return { video, audio, duration };
    }

    // ---- Variant build (now on clean content-script data) --------------------
    function buildVariants(dash) {
        if (!dash.video.length || !dash.audio.length) return null;
        const bestAudio = dash.audio.slice()
            .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
        if (!bestAudio.baseUrl) return null;
        const variants = dash.video.slice()
            .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
            .map(v => ({
                url: v.baseUrl,
                audioUrl: bestAudio.baseUrl,
                width: v.width || 0,
                height: v.height || 0,
                videoCodec: v.codecs || undefined,
                audioCodec: bestAudio.codecs || undefined,
                videoBackupUrl: v.backupUrl || undefined,
                audioBackupUrl: bestAudio.backupUrl || undefined
            }));
        if (!variants.length) return null;
        return { variants, durationMs: dash.duration > 0 ? Math.round(dash.duration * 1000) : 0 };
    }

    // ---- Generic page metadata from the DOM (no per-site logic) --------------
    function ogMeta(prop) {
        const el = document.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`);
        return el && el.getAttribute("content") ? el.getAttribute("content").trim() : "";
    }
    function pageTitle() {
        const og = ogMeta("og:title");
        if (og) return og;
        const t = (document.title || "").split(/\s[-|]\s/)[0].trim();
        return t || location.host || "video";
    }

    // Read a string/number property off an Xray-waived object, defensively.
    function readPrim(o, key) {
        try {
            const v = o[key];
            return (typeof v === "string" || typeof v === "number") ? v : null;
        } catch (_) { return null; }
    }

    // Bilibili.tv episode model lives at root.ogv: season.title + the playing
    // episode (ogv.epId matched against ogv.sectionsList[].episodes[].episode_id)
    // give an episode-precise "Season Episode" title and a per-episode cover.
    // Index-loop / primitive reads only (Xray-safe). Returns null if absent.
    function resolveBilibiliMeta(root) {
        let ogv;
        try { ogv = root.ogv; } catch (_) { ogv = null; }
        if (!ogv || typeof ogv !== "object") return null;

        let season;
        try { season = ogv.season || {}; } catch (_) { season = {}; }
        const seasonTitle = readPrim(season, "title");

        let epId = readPrim(ogv, "epId");
        epId = epId != null ? String(epId) : null;

        let epPart = null, cover = null;
        let sections;
        try { sections = ogv.sectionsList; } catch (_) { sections = null; }
        let slen = 0;
        try { slen = (sections && typeof sections.length === "number") ? sections.length : 0; } catch (_) { slen = 0; }
        for (let i = 0; i < slen && !epPart; i++) {
            let sec;
            try { sec = sections[i]; } catch (_) { continue; }
            let eps;
            try { eps = sec && sec.episodes; } catch (_) { eps = null; }
            let elen = 0;
            try { elen = (eps && typeof eps.length === "number") ? eps.length : 0; } catch (_) { elen = 0; }
            for (let j = 0; j < elen; j++) {
                let ep;
                try { ep = eps[j]; } catch (_) { continue; }
                const eid = readPrim(ep, "episode_id");
                if (epId && eid != null && String(eid) === epId) {
                    epPart = readPrim(ep, "title_display")
                        || readPrim(ep, "long_title_display")
                        || readPrim(ep, "short_title_display");
                    cover = readPrim(ep, "cover");
                    break;
                }
            }
        }

        let title = null;
        if (epPart) title = seasonTitle ? `${seasonTitle} ${epPart}` : epPart;
        if (!title) title = seasonTitle || null;
        const img = cover || readPrim(season, "horizontal_cover")
            || readPrim(season, "vertical_cover") || null;
        if (!title && !img) return null;
        return { title: title || undefined, img: img || undefined };
    }

    // Host-keyed metadata enrichment. Default is generic (og:/document.title +
    // og:image); a known host whose page state carries richer fields overrides
    // it. Add a host branch here (not a new content script) — this is the one
    // place that already holds the page-world `root`, which the background can't
    // read. Per-site REQUEST/emit specifics still belong in background.js.
    function resolveMeta(root) {
        let rich = null;
        try {
            if (/(?:^|\.)bilibili\.tv$/i.test(location.hostname)) {
                rich = resolveBilibiliMeta(root);
            }
        } catch (_) {}
        return {
            title: (rich && rich.title) || pageTitle(),
            img: (rich && rich.img) || ogMeta("og:image") || undefined
        };
    }

    // ---- Read page-world state via the Xray wrappedJSObject waiver -----------
    // Returns { root, dash } — root is the state global that held the dash slice,
    // so a host-keyed metadata resolver can read sibling fields (e.g. ogv).
    function readPageState() {
        let pw;
        try { pw = window.wrappedJSObject; } catch (_) { pw = null; }
        if (!pw) return null;
        for (const name of STATE_GLOBALS) {
            let g;
            try { g = pw[name]; } catch (_) { continue; }
            if (!g || typeof g !== "object") continue;
            // Fast known path (bilibili.tv: player.playUrl.dash) — direct reads,
            // no enumeration. Then a bounded generic search for everything else.
            try {
                const direct = g.player && g.player.playUrl && g.player.playUrl.dash;
                if (isDashShape(direct)) return { root: g, dash: direct };
            } catch (_) {}
            let dash;
            try { dash = findDash(g); } catch (_) { dash = null; }
            if (dash) return { root: g, dash };
        }
        return null;
    }

    // ---- HLS master from a page-world JS player (JWPlayer …) -----------------
    // A site can hand a (often obfuscated) HLS master to a player that fetches it
    // only on PLAY (preload:none) — so the wire never sees it until the user
    // clicks. But to play, the player must hold the DE-OBFUSCATED url, so we read
    // it from the player's resolved state via the same wrappedJSObject waiver.
    // Agnostic to however the site packed the source (we read the result, not the
    // packed blob), so it's not cat-and-mouse. Index-loop / primitive reads only
    // (Xray-safe). Runs in subframes too (all_frames) because the player is
    // usually an embedded cross-origin iframe.
    const HLS_RE = /^https?:\/\/[^\s"']+\.m3u8(?:[?#]|$)/i;

    // Pull an HLS .m3u8 (and a title if present) out of a JWPlayer playlist item.
    function readHlsFromItem(item) {
        if (!item || typeof item !== "object") return null;
        let url = null;
        const f = readPrim(item, "file");
        if (typeof f === "string" && HLS_RE.test(f)) url = f;
        if (!url) {
            let sources;
            try { sources = item.sources; } catch (_) { sources = null; }
            let n = 0;
            try { n = (sources && typeof sources.length === "number") ? sources.length : 0; } catch (_) { n = 0; }
            for (let i = 0; i < n && !url; i++) {
                let s;
                try { s = sources[i]; } catch (_) { continue; }
                const sf = readPrim(s, "file");
                if (typeof sf === "string" && HLS_RE.test(sf)) url = sf;
            }
        }
        if (!url) return null;
        const t = readPrim(item, "title");
        return { url, title: (typeof t === "string" && t.trim()) ? t.trim() : null };
    }

    // JWPlayer (jw8) covers the common embed hosts (vibuxer / luluvdo /
    // lulustream …): jwplayer().getPlaylist() → [{file, sources:[{file}], title}],
    // resolved at setup() — preload:none defers only the FETCH, not setup, so the
    // url is present on load. Add another player as a new block here, never a
    // per-site file. Returns { url, title } or null.
    function findPlayerHls() {
        let pw;
        try { pw = window.wrappedJSObject; } catch (_) { pw = null; }
        if (!pw) return null;

        let jw;
        try { jw = pw.jwplayer; } catch (_) { jw = null; }
        if (typeof jw === "function") {
            let api;
            try { api = jw(); } catch (_) { api = null; }
            if (api && typeof api === "object") {
                let pl;
                try { pl = api.getPlaylist(); } catch (_) { pl = null; }
                let n = 0;
                try { n = (pl && typeof pl.length === "number") ? pl.length : 0; } catch (_) { n = 0; }
                for (let i = 0; i < n; i++) {
                    let it;
                    try { it = pl[i]; } catch (_) { continue; }
                    const hit = readHlsFromItem(it);
                    if (hit) return hit;
                }
            }
        }
        return null;
    }

    // ---- Emit + lifecycle ----------------------------------------------------
    const sentKeys = new Set();
    let spaArmed = false;

    function extractAndSend(label) {
        // 1) SSR-inlined DASH slice (bilibili.tv etc.) → video+audio variants.
        const state = readPageState();
        if (state) {
            const built = buildVariants(cloneDash(state.dash));
            if (built) {
                // Dedup so retries / SPA re-reads don't re-emit the same set.
                const key = built.variants.map(v => v.url).join("|");
                if (sentKeys.has(key)) { armSpaObserver(); return true; }
                sentKeys.add(key);
                const meta = resolveMeta(state.root);
                const payload = {
                    variants: built.variants,
                    origin: location.href,
                    title: meta.title,
                    img: meta.img,
                    durationMs: built.durationMs
                };
                log("sending", built.variants.length, "variant(s) at", label, payload.title);
                browser.runtime.sendMessage({ kind: "page-state-media", payload }).then(() => {}, () => {});
                armSpaObserver();
                return true;
            }
        }

        // 2) A JS player holding a preload:none HLS master (read the resolved url,
        //    so we capture without the user pressing play). The native side
        //    enumerates the master (no probe); the played master URL dedups by URL
        //    against this, and its raw .ts segments are dropped natively (mpegts).
        const hls = findPlayerHls();
        if (hls && hls.url) {
            if (sentKeys.has(hls.url)) { armSpaObserver(); return true; }
            sentKeys.add(hls.url);
            const meta = resolveMeta(null);
            const payload = {
                url: hls.url,
                origin: location.href,
                title: hls.title || meta.title,
                img: meta.img
            };
            log("sending HLS master at", label, payload.title, hls.url.slice(0, 80));
            browser.runtime.sendMessage({ kind: "page-state-hls", payload }).then(() => {}, () => {});
            armSpaObserver();
            return true;
        }
        return false;
    }

    // SPA episode navigation swaps the page model without a document reload.
    // Only armed once we've actually seen inlined media, so the ~all sites that
    // have none never pay for a persistent subtree observer.
    function armSpaObserver() {
        if (spaArmed) return;
        spaArmed = true;
        let lastUrl = location.href;
        let debounce = null;
        new MutationObserver(() => {
            if (location.href === lastUrl) return;
            lastUrl = location.href;
            sentKeys.clear();
            clearTimeout(debounce);
            debounce = setTimeout(() => extractAndSend("spa"), 600);
        }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // State lands during page JS execution; try now, at DOMContentLoaded, and a
    // couple of short retries. Each is a cheap no-op when no media state exists.
    extractAndSend("immediate");
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => extractAndSend("DOMContentLoaded"), { once: true });
    }
    setTimeout(() => extractAndSend("t500"), 500);
    setTimeout(() => extractAndSend("t1500"), 1500);
    // A JS player's setup() can lag the page load, so one later attempt — a cheap
    // no-op in the ~all frames (incl. ad iframes) that have no player global.
    setTimeout(() => extractAndSend("t4000"), 4000);
})();
