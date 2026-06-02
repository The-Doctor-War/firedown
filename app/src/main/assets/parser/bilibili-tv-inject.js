// Runs in bilibili.tv's page world. Loaded via <script src="moz-extension://…">
// from bilibili-tv-content.js so it bypasses the page CSP (extension-origin
// resources are exempt) — an inline <script> would be blocked.
//
// bilibili.tv SSR-inlines the playurl into window.__initialState (a devalue
// IIFE the page evaluates at load), so by the time we run, __initialState is a
// fully-formed object. We read player.playUrl.dash.{video[],audio[]} straight
// off it — no devalue parsing, no separate playurl XHR (there isn't one). Each
// rep carries baseUrl/backupUrl + bandwidth/codecs/width/height. We pair every
// video rep with the highest-bitrate audio and post the result to the content
// script, which forwards to the background. The background emits them as
// video+audio variants; native FFmpegMergeStrategy muxes the two .m4s tracks.
(() => {
    'use strict';

    let DEBUG = false;
    const log = (...args) => { if (DEBUG) console.log('[BILI-TV-INJECT]', ...args); };
    // Content script forwards BuildConfig.DEBUG over the same channel.
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (d && d.__firedown_bili__ === 2) DEBUG = !!d.debug;
    });

    // Find the dash object: prefer the known path, but fall back to a bounded
    // structural search for any object with video[] + audio[] arrays whose
    // entries look like dash reps (baseUrl/base_url + bandwidth).
    function looksLikeRep(o) {
        return o && typeof o === 'object'
            && (typeof o.baseUrl === 'string' || typeof o.base_url === 'string')
            && typeof o.bandwidth === 'number';
    }
    function looksLikeDash(o) {
        return o && typeof o === 'object'
            && Array.isArray(o.video) && Array.isArray(o.audio)
            && o.video.some(looksLikeRep);
    }
    function findDash(root) {
        const direct = root?.player?.playUrl?.dash;
        if (looksLikeDash(direct)) return direct;
        const seen = new Set();
        let found = null;
        (function walk(o, depth) {
            if (found || !o || typeof o !== 'object' || depth > 8 || seen.has(o)) return;
            seen.add(o);
            if (looksLikeDash(o)) { found = o; return; }
            const vals = Array.isArray(o) ? o : Object.values(o);
            for (const v of vals) walk(v, depth + 1);
        })(root, 0);
        return found;
    }

    function repUrl(r) { return r.baseUrl || r.base_url || null; }
    function repBackup(r) {
        const b = r.backupUrl || r.backup_url;
        return Array.isArray(b) && b.length ? b[0] : null;
    }

    // Locate the currently-playing episode via ogv.epId, matched against
    // ogv.sectionsList[].episodes[].episode_id. Gives us the exact per-episode
    // cover + a precise title; falls back to season-level data.
    function findCurrentEpisode(ogv) {
        const epId = ogv?.epId != null ? String(ogv.epId) : null;
        const sections = Array.isArray(ogv?.sectionsList) ? ogv.sectionsList : [];
        for (const sec of sections) {
            const eps = Array.isArray(sec?.episodes) ? sec.episodes : [];
            for (const ep of eps) {
                if (epId && String(ep.episode_id) === epId) return ep;
            }
        }
        return null;
    }

    // Title: prefer the episode's display title within the season; else the
    // season title; else document.title with the site suffix stripped.
    function resolveMeta(root) {
        const ogv = root?.ogv || {};
        const season = ogv.season || {};
        const ep = findCurrentEpisode(ogv);

        let title = null;
        if (ep) {
            const epPart = ep.title_display || ep.long_title_display || ep.short_title_display;
            title = season.title && epPart ? `${season.title} ${epPart}` : (epPart || season.title);
        }
        if (!title) title = season.title;
        if (!title) {
            const t = (document.title || '').split(/\s[-|]\s/)[0].trim();
            title = (t && !/^bilibili/i.test(t)) ? t : 'bilibili.tv';
        }

        const img = (ep && ep.cover) || season.horizontal_cover || season.vertical_cover || undefined;
        return { title, img };
    }

    function extractAndPost() {
        let state;
        try { state = window.__initialState; } catch (_) { state = null; }
        if (!state) { log('no __initialState'); return false; }

        const dash = findDash(state);
        if (!dash) { log('no dash in state'); return false; }

        const videos = dash.video.filter(looksLikeRep);
        const audios = dash.audio.filter(looksLikeRep);
        if (!videos.length || !audios.length) { log('empty video/audio reps'); return false; }

        // Highest-bitrate audio paired with every video quality.
        const bestAudio = audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
        const audioUrl = repUrl(bestAudio);
        if (!audioUrl) { log('audio rep has no url'); return false; }

        const variants = videos
            .slice()
            .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))
            .map(v => {
                const url = repUrl(v);
                if (!url) return null;
                return {
                    url,
                    audioUrl,
                    width: v.width || 0,
                    height: v.height || 0,
                    videoCodec: v.codecs || undefined,
                    audioCodec: bestAudio.codecs || undefined,
                    videoBackupUrl: repBackup(v) || undefined,
                    audioBackupUrl: repBackup(bestAudio) || undefined
                };
            })
            .filter(Boolean);
        if (!variants.length) { log('no usable variants'); return false; }

        const durationSec = Number(dash.duration) || 0;
        const meta = resolveMeta(state);
        const payload = {
            variants,
            origin: location.href,
            title: meta.title,
            img: meta.img,
            durationMs: durationSec > 0 ? Math.round(durationSec * 1000) : 0
        };
        log('posting', variants.length, 'variant(s), audio', audioUrl.slice(0, 60));
        try { window.postMessage({ __firedown_bili__: 1, payload }, '*'); } catch (e) { log('post failed', e && e.message); }
        return true;
    }

    // Read now; if the state isn't ready yet, retry a few times. Also re-read
    // on demand (content script pings after SPA episode navigation).
    let sent = false;
    function attempt(label) {
        if (sent) return;
        if (extractAndPost()) { sent = true; log('sent at', label); }
    }
    attempt('immediate');
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => attempt('DOMContentLoaded'), { once: true });
    }
    setTimeout(() => attempt('t500'), 500);
    setTimeout(() => attempt('t1500'), 1500);

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (event.data && event.data.__firedown_bili__ === 3) { // re-read request (SPA nav)
            sent = false;
            attempt('reread');
        }
    });
})();
