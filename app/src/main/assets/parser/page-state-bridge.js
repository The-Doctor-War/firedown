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
        if (!pw) { log("hls-probe: no wrappedJSObject @", location.host); return null; }

        let jw;
        try { jw = pw.jwplayer; } catch (_) { jw = null; }
        // No JWPlayer in this frame: stay silent (this runs in every frame incl.
        // ad iframes, so logging here would spam). Verbose only once a player is
        // actually present, to pinpoint where extraction fails.
        if (typeof jw !== "function") return null;

        log("hls-probe: jwplayer present @", location.host);
        let api;
        try { api = jw(); } catch (e) { log("hls-probe: jwplayer() threw:", e && e.message); return null; }
        if (!api || typeof api !== "object") { log("hls-probe: jwplayer() gave no api (player not set up yet?)"); return null; }

        let getPl;
        try { getPl = api.getPlaylist; } catch (_) { getPl = null; }
        if (typeof getPl !== "function") { log("hls-probe: api has no getPlaylist()"); return null; }

        let pl;
        try { pl = api.getPlaylist(); } catch (e) { log("hls-probe: getPlaylist() threw:", e && e.message); return null; }
        let n = 0;
        try { n = (pl && typeof pl.length === "number") ? pl.length : 0; } catch (_) { n = 0; }
        log("hls-probe: getPlaylist length =", n);

        for (let i = 0; i < n; i++) {
            let it;
            try { it = pl[i]; } catch (_) { continue; }
            const f = readPrim(it, "file");
            let nsrc = 0;
            try { const s = it.sources; nsrc = (s && typeof s.length === "number") ? s.length : 0; } catch (_) { nsrc = 0; }
            const hit = readHlsFromItem(it);
            log("hls-probe: item", i,
                "file=", f != null ? String(f).slice(0, 90) : "(none)",
                "sources=", nsrc,
                "hit=", hit ? hit.url.slice(0, 90) : "no");
            if (hit) return hit;
        }
        log("hls-probe: no .m3u8 in playlist");
        return null;
    }

    // Browser-shaped navigator hints for a native re-fetch that must look real to
    // a stream CDN's anti-bot. UA verbatim; Accept-Language built WITH q-values
    // ("en-US,ko-KR;q=0.9") — a bare comma-join is a bot tell that once cost a 403
    // (proven on-device: the only header differing from the request that got 200).
    function readNavigatorHints() {
        let ua = "", lang = "";
        try { ua = navigator.userAgent || ""; } catch (_) { ua = ""; }
        try {
            let ls = [];
            if (navigator.languages && navigator.languages.length) ls = navigator.languages;
            else if (navigator.language) ls = [navigator.language];
            if (ls.length) {
                lang = ls[0];
                for (let i = 1, q = 9; i < ls.length && q >= 1; i++, q--) {
                    lang += "," + ls[i] + ";q=0." + q;
                }
            }
        } catch (_) { lang = ""; }
        return { ua, lang };
    }

    // Post an HLS master to background (Java enumerates qualities, no probe). The
    // stream CDN's anti-bot rejects any non-browser-like request, so we send the
    // real UA + q-valued Accept-Language for background.js to rebuild the request.
    function postHlsMaster(url, title, img, label) {
        const { ua, lang } = readNavigatorHints();
        const payload = { url, origin: location.href, title, img, ua, lang };
        log("sending HLS master at", label, title, url.slice(0, 80));
        browser.runtime.sendMessage({ kind: "page-state-hls", payload }).then(() => {}, () => {});
    }

    // ---- mediaDefinitions player (Pornhub-network family) --------------------
    // tube8 / pornhub / youporn / redtube and their white-label clones inline,
    // into a page-world global (page_params.video_player_setup.playervars), a
    // `mediaDefinitions` array plus rich metadata (video_title / video_duration /
    // image_url). Each entry's `videoUrl` is EITHER a direct media URL OR a
    // same-origin JSON DELEGATE (…/media/mp4/?s=<token>) returning
    // [{quality, videoUrl:…mp4}]. The page fetches that delegate on LOAD (not on
    // play), so the real progressive URLs exist pre-play — but only inside an
    // application/json XHR body, which the generic catcher rejects, and never in
    // the DOM (the page carries only the tokenized delegate). So nothing is
    // captured until the user presses play and the wire finally sees a real .mp4.
    // We read mediaDefinitions page-world (same wrappedJSObject waiver as the HLS
    // path), resolve the delegate with a SAME-ORIGIN fetch (the bridge runs ON the
    // page, so no host permission is needed), and emit the variants. Generic by
    // SHAPE (the player), not by host — exactly like findPlayerHls is generic to
    // JWPlayer. A direct .mp4/.webm becomes a progressive variant; a direct .m3u8
    // rides the existing HLS-master path.
    const DIRECT_MEDIA_RE = /^https?:\/\/[^\s"']+\.(?:mp4|m4v|webm)(?:[?#]|$)/i;
    const HLS_MASTER_RE = /^https?:\/\/[^\s"']+\.m3u8(?:[?#]|$)/i;

    // True when `o` looks like a playervars object: it carries a non-empty
    // mediaDefinitions array whose first entry has an http(s) `videoUrl`.
    function looksLikeMediaDefs(o) {
        if (!o || typeof o !== "object") return false;
        let md;
        try { md = o.mediaDefinitions; } catch (_) { return false; }
        if (!md) return false;
        let n;
        try { n = md.length; } catch (_) { return false; }
        if (typeof n !== "number" || n === 0) return false;
        let first;
        try { first = md[0]; } catch (_) { return false; }
        if (!first || typeof first !== "object") return false;
        const vu = readPrim(first, "videoUrl");
        return typeof vu === "string" && /^https?:\/\//i.test(vu);
    }

    // Bounded search for the playervars object inside a page-world global. Fast
    // known path first (Pornhub-network: video_player_setup.playervars), then a
    // depth/node-capped generic walk. Index loops / direct reads only (Xray-safe).
    function findPlayervars(root) {
        try {
            const pv = root.video_player_setup && root.video_player_setup.playervars;
            if (looksLikeMediaDefs(pv)) return pv;
        } catch (_) {}
        if (looksLikeMediaDefs(root)) return root;
        const seen = new Set();
        let budget = 20000;
        let found = null;
        (function walk(o, depth) {
            if (found || !o || typeof o !== "object" || depth > 8 || budget-- <= 0) return;
            if (seen.has(o)) return;
            seen.add(o);
            if (looksLikeMediaDefs(o)) { found = o; return; }
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

    // Probe the known state globals (plus page_params, where the Pornhub-network
    // player lives) for a playervars object. Cheap no-op when none holds one.
    function readMediaDefs() {
        let pw;
        try { pw = window.wrappedJSObject; } catch (_) { pw = null; }
        if (!pw) return null;
        const names = ["page_params"].concat(STATE_GLOBALS);
        for (const name of names) {
            let g;
            try { g = pw[name]; } catch (_) { continue; }
            if (!g || typeof g !== "object") continue;
            let pv;
            try { pv = findPlayervars(g); } catch (_) { pv = null; }
            if (pv) return pv;
        }
        return null;
    }

    // Extract { url, format, quality } from each mediaDefinitions entry (Xray-safe
    // primitive reads). Bounded to 50 entries.
    function extractMediaDefs(pv) {
        const out = [];
        let md;
        try { md = pv.mediaDefinitions; } catch (_) { md = null; }
        let n = 0;
        try { n = (md && typeof md.length === "number") ? md.length : 0; } catch (_) { n = 0; }
        for (let i = 0; i < n && i < 50; i++) {
            let d;
            try { d = md[i]; } catch (_) { continue; }
            const url = readPrim(d, "videoUrl");
            if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
            const format = readPrim(d, "format");
            const quality = readPrim(d, "quality");
            out.push({
                url,
                format: typeof format === "string" ? format : "",
                quality: quality != null ? String(quality) : ""
            });
        }
        return out;
    }

    // Title / duration / cover from the same playervars (generic field names the
    // Pornhub-network player uses), falling back to the page's og:/title.
    function mediaDefsMeta(pv) {
        const t = readPrim(pv, "video_title");
        const durRaw = readPrim(pv, "video_duration");
        const dur = Number(durRaw);
        const img = readPrim(pv, "image_url");
        return {
            title: (typeof t === "string" && t.trim()) ? t.trim() : pageTitle(),
            durationMs: (isFinite(dur) && dur > 0) ? Math.round(dur * 1000) : 0,
            img: (typeof img === "string" && img) ? img : (ogMeta("og:image") || undefined)
        };
    }

    // Resolve a same-origin JSON delegate (…/media/mp4/?s=<token>) to its real
    // media URLs. The page already made this exact fetch on load, so a same-origin
    // credentialed re-fetch is cheap and authenticated. Returns [{url, height}].
    async function fetchMediaList(url) {
        let data;
        try {
            const resp = await fetch(url, { credentials: "include", cache: "no-store" });
            if (!resp || !resp.ok) return [];
            data = await resp.json();
        } catch (_) { return []; }
        const out = [];
        let n = 0;
        try { n = (data && typeof data.length === "number") ? data.length : 0; } catch (_) { n = 0; }
        for (let i = 0; i < n && i < 50; i++) {
            const it = data[i];
            if (!it || typeof it !== "object") continue;
            const u = (typeof it.videoUrl === "string" && it.videoUrl)
                || (typeof it.url === "string" && it.url)
                || (typeof it.src === "string" && it.src);
            if (typeof u !== "string" || !/^https?:\/\//i.test(u)) continue;
            const h = parseInt(it.quality || it.height || it.label, 10) || 0;
            out.push({ url: u, height: h });
        }
        return out;
    }

    // Pre-fetch guard: don't re-resolve the same delegate set across the retry
    // passes (immediate/DOMContentLoaded/t500/t1500/t4000). Cleared on SPA nav.
    const mediaDefsTried = new Set();

    async function resolveAndEmitMediaDefs(pv, label) {
        const defs = extractMediaDefs(pv);
        if (!defs.length) return false;
        const preKey = defs.map(d => d.url).join("|");
        if (mediaDefsTried.has(preKey)) return true;
        mediaDefsTried.add(preKey);

        const meta = mediaDefsMeta(pv);
        const progressive = []; // { url, height }
        let hlsMaster = null;

        for (const def of defs) {
            if (HLS_MASTER_RE.test(def.url)) {
                if (!hlsMaster) hlsMaster = def.url;
            } else if (DIRECT_MEDIA_RE.test(def.url)) {
                progressive.push({ url: def.url, height: parseInt(def.quality, 10) || 0 });
            } else {
                // Tokenized JSON delegate — resolve to the real media URLs.
                const list = await fetchMediaList(def.url);
                for (const item of list) {
                    if (HLS_MASTER_RE.test(item.url)) {
                        if (!hlsMaster) hlsMaster = item.url;
                    } else if (DIRECT_MEDIA_RE.test(item.url)) {
                        progressive.push({ url: item.url, height: item.height });
                    }
                }
            }
        }

        if (progressive.length) {
            // Dedup by URL, best (highest) quality first.
            const byUrl = new Map();
            for (const v of progressive) { if (!byUrl.has(v.url)) byUrl.set(v.url, v); }
            const variants = Array.from(byUrl.values())
                .sort((a, b) => (b.height || 0) - (a.height || 0))
                .map(v => ({ url: v.url, width: 0, height: v.height || 0 }));
            if (!sentKeys.has(variants[0].url)) {
                sentKeys.add(variants[0].url);
                const payload = {
                    variants,
                    origin: location.href,
                    title: meta.title,
                    img: meta.img,
                    durationMs: meta.durationMs
                };
                log("sending", variants.length, "mediaDefs progressive variant(s) at", label, meta.title);
                browser.runtime.sendMessage({ kind: "page-state-progressive", payload }).then(() => {}, () => {});
            }
        }
        if (hlsMaster && !sentKeys.has(hlsMaster)) {
            sentKeys.add(hlsMaster);
            postHlsMaster(hlsMaster, meta.title, meta.img, label);
        }
        return true;
    }

    // ---- Mega.nz links (folder, single file, embed) --------------------------
    // Mega is zero-knowledge: the decryption key lives in the URL fragment (after
    // #), which is NEVER sent to any server — so neither the wire nor the DOM can
    // see it, only page-world. We don't even need wrappedJSObject here: the handle
    // is in the path and the key is in location.hash. We hand both to the
    // background, which talks to Mega's API natively (anonymous cs `f`/`g`) and
    // emits entities; the file bytes are AES-CTR ciphertext on the wire, so the
    // generic catcher can't produce a usable download — the native MegaStrategy
    // decrypts on download instead.
    //
    // Shapes handled (modern + legacy):
    //   folder: /folder/<h>#<key>[/folder|/file/<sub>]   |  #F!<h>!<key>
    //   file:   /file/<h>#<key>                           |  #!<h>!<key>
    //   embed:  /embed/<h>#<key>  (a single file in a cross-origin iframe — the
    //           bridge reaches it because it runs all_frames)
    // A folder key is 128-bit (~22 base64url chars); a file key is 256-bit (~43).
    // The first hash segment is the key; anything after a '/' is in-app nav state.
    function parseMegaLink(pathname, rawHash) {
        let hash = (rawHash || "").replace(/^#/, "");
        // Legacy: #F!<h>!<key> (folder) / #!<h>!<key> (file), possibly under /embed.
        if (hash[0] === "F" && hash[1] === "!") {
            const p = hash.slice(2).split("!");
            if (p[0] && p[1]) return { kind: "folder", handle: p[0], key: p[1] };
        }
        if (hash[0] === "!") {
            const p = hash.slice(1).split("!");
            if (p[0] && p[1]) return { kind: "file", handle: p[0], key: p[1] };
        }
        // Modern path-based forms.
        let m;
        if ((m = /^\/folder\/([0-9A-Za-z_-]+)/.exec(pathname))) {
            return { kind: "folder", handle: m[1], key: hash.split("/")[0] };
        }
        if ((m = /^\/(?:file|embed)\/([0-9A-Za-z_-]+)/.exec(pathname))) {
            return { kind: "file", handle: m[1], key: hash.split("/")[0] };
        }
        return null;
    }

    function extractMega() {
        let host;
        try { host = location.hostname; } catch (_) { return false; }
        if (!/(?:^|\.)mega\.(nz|co\.nz)$/i.test(host)) return false;

        let link;
        try { link = parseMegaLink(location.pathname || "", location.hash || ""); } catch (_) { link = null; }
        if (!link || !link.handle || !link.key) return false;
        // Reject the wrong-size key for the link kind (a folder key is ~22 chars,
        // a file key ~43) so a half-loaded URL doesn't emit a doomed capture.
        const minLen = link.kind === "folder" ? 16 : 40;
        if (link.key.length < minLen) return false;

        const dedupKey = "mega:" + link.kind + ":" + link.handle;
        if (sentKeys.has(dedupKey)) { armSpaObserver(); return true; }
        sentKeys.add(dedupKey);

        const title = (document.title || "").split(/\s[-|]\s/)[0].trim();
        const img = ogMeta("og:image") || undefined;

        if (link.kind === "folder") {
            const folderPage = location.origin + "/folder/" + link.handle;
            const payload = {
                folderHandle: link.handle,
                masterKey: link.key,
                origin: folderPage, // clean page URL, no key fragment
                title: title || "Mega folder",
                img
            };
            log("sending mega folder", link.handle, "key", link.key.length, "chars");
            browser.runtime.sendMessage({ kind: "mega-folder", payload }).then(() => {}, () => {});
        } else {
            const filePage = location.origin + "/file/" + link.handle;
            const payload = {
                fileHandle: link.handle,
                fileKey: link.key,
                origin: filePage,
                title: title || undefined, // real name comes from the native attr fetch
                img
            };
            log("sending mega file", link.handle, "key", link.key.length, "chars");
            browser.runtime.sendMessage({ kind: "mega-file", payload }).then(() => {}, () => {});
        }
        armSpaObserver();
        return true;
    }

    // ---- Emit + lifecycle ----------------------------------------------------
    const sentKeys = new Set();
    let spaArmed = false;
    let loggedFrame = false;

    function extractAndSend(label) {
        // One line per frame (after DEBUG resolves) so you can confirm the bridge
        // is actually running INSIDE the player iframe — i.e. all_frames took and
        // the version bump re-registered. If you never see the player iframe's
        // host here, the bridge isn't reaching it (re-register / all_frames issue).
        if (!loggedFrame) {
            loggedFrame = true;
            log("bridge active @", location.host, "top=" + (window === window.top), "label=" + label);
        }
        // 0) Mega.nz folder / file / embed link — key is in the URL fragment,
        //    page-world only (neither wire nor DOM can see it).
        if (extractMega()) return true;

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
            postHlsMaster(hls.url, hls.title || meta.title, meta.img, label);
            armSpaObserver();
            return true;
        }

        // 3) mediaDefinitions player (Pornhub-network family: tube8, pornhub,
        //    youporn, redtube, white-label clones). The real media list is fetched
        //    on LOAD into a same-origin JSON delegate the catcher drops, so nothing
        //    is captured until play. Read it page-world + resolve the delegate.
        //    Async (a same-origin fetch), so fire-and-forget and arm the observer.
        const pv = readMediaDefs();
        if (pv) {
            resolveAndEmitMediaDefs(pv, label).then(() => {}, () => {});
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
            mediaDefsTried.clear();
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
