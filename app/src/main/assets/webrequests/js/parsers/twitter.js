// Twitter / X parser — split verbatim out of the former parser-background.js.
import { log, tryParseJson, sendVariants, sendSubtitles, urlToTabCache } from './common.js';

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
                // Twitter progressive mp4s are always H.264/AAC. Supplying the
                // codecs here lets the Java side trust the parser metadata and
                // skip the capture-time ffmpeg probe (the variant already carries
                // url + resolution, and duration comes from duration_millis). A
                // single progressive .mp4 has no separate audio, so
                // VariantProcessor keeps it on the byte-exact HttpDownloadStrategy
                // (type FILE), not an ffmpeg remux.
                return {
                    url: v.url,
                    width: wh ? parseInt(wh[1]) : 0,
                    height: wh ? parseInt(wh[2]) : 0,
                    bitrate: v.bitrate || 0,
                    videoCodec: "h264",
                    audioCodec: "aac"
                };
            });
        if (variants.length === 0) continue;
        emitted = true;
        // Do NOT hardcode skipProbe. Let sendVariants auto-enable it when
        // duration > 0 (the normal case — duration_millis is present, so the
        // probe is skipped exactly as before). When duration_millis is absent or
        // 0 (animated-GIF-as-video, some embed/SPA response shapes), leaving
        // skipProbe off lets the capture-time ffmpeg probe backfill the real
        // duration — otherwise Twitter would uniquely emit NO duration tag while
        // every other progressive parser (Instagram/Threads/Facebook) recovers it.
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

