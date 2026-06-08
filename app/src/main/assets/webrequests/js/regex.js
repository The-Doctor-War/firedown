import { DEBUG } from './debug.js';

// Remote regex pattern list URL
const REGEX_URL = 'https://raw.githubusercontent.com/solarizeddev/firedown-webrequests/main/regex-patterns.txt';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // Refresh every 6 hours

// Bundled fallback patterns (used if remote fetch fails on first load).
//
// SCOPE: generic, CDN-agnostic junk only — telemetry/beacon endpoints and
// init/numbered HLS-DASH segment fragments that are never standalone media.
// PARSER-DEDUP host/CDN blocks (the cardinal rule — keeping the generic catcher
// off a site that has a dedicated parser) live in parser-blocklist.js, keyed by
// parser. Don't add per-parser media blocks here; add them there.
const DEFAULT_PATTERNS = [
  // YouTube
  'youtube\\.com\\/(complete\\/search|api\\/stats)',
  'youtube\\.com.*\\.mp3',
  'youtube-nocookie\\.com\\/api\\/stats',
  '\\.youtube\\.com\\/api',

  // Google
  '\\.google.*\\/(async|verify)\\/',
  'googleapis\\.com\\/(\\$rpc|identitytoolkit)\\/',
  'ogads-pa\\.clients.*\\.google\\.com\\/\\$rpc\\/google\\.internal\\.onegoogle\\.asyncdata',
  'news\\.google\\.com\\/.*\\/jserror',

  // Bing / Microsoft
  'bing\\.com\\/(rewardsapp\\/reportActivity|notifications\\/handle|AS\\/Suggestions|ipv6test\\/test|videos\\/async|sharing\\/getsharecommoncontrol|images\\/detail\\/insights|images\\/search\\?view)',
  'microsoft-api\\.arkoselabs\\.com',
  'copilot\\.microsoft\\.com\\/(fd\\/ls\\/l|cl\\/eus2\\/collect)',

  // TikTok — telemetry only. (The webapp-prime media URLs are intentionally NOT
  // blocked anywhere — neither here nor in parser-blocklist.js — so the generic
  // catcher can grab the cache-served first /foryou video the parser can't see.
  // See the TikTok note in CLAUDE.md. These /report entries are not media.)
  'tiktok\\.com\\/aweme\\/v1\\/report',
  'tiktokw.*\\/web\\/report',

  // CloudFront (general media) — a broad CDN block, not tied to one parser.
  // (Twitch's own cloudfront VOD index playlists are a parser-dedup rule in
  // parser-blocklist.js.)
  'cloudfront\\.net.*\\.(ts|mp4)',

  // Instagram — login/ajax telemetry. (The Instagram/Threads media block,
  // instagram.*\.mp4, is a parser-dedup rule in parser-blocklist.js.)
  'instagram\\.com\\/(accounts\\/login|ajax)',

  // Dailymotion — history/log telemetry. (Its media blocks are in
  // parser-blocklist.js.)
  'dailymotion\\.com\\/history\\/log\\/user',

  // SoundCloud (init segment)
  '\\.soundcloud\\.cloud\\/.*\\/init\\.mp4',

  // StreamTheWorld (HLS radio segments)
  'live\\.streamtheworld\\.com.*\\.aac',

  // Akamai
  '\\.akamaized\\.net\\/.*\\/(init|cmaf-|chunk-|segment[-_]?)[^/]*\\.(mp4|m4s)',

  // Generic CMAF / fMP4 initialization segments. These hold the moov
  // box for an HLS / DASH stream and are referenced by the parent
  // playlist's #EXT-X-MAP: URI=... — they're never standalone media,
  // so probing one in isolation triggers the same
  // 'trun track id unknown, no tfhd was found' decoder dead-end as a
  // bare .m4s fragment. Filename is universally 'init' across CDNs
  // that ship CMAF (smoothpal, generic nginx setups, …); the
  // domain-specific entries above cover the cases where the path
  // doesn't follow that convention. Covers init / init01 / init-1 / init_0
  // and the common init extensions (this also generalizes the niconico
  // init01.cmfv case — niconico's own host rule in parser-blocklist.js still
  // covers its data segments).
  '\\/init[-_]?\\d*\\.(mp4|m4s|cmf[va]|ts|aac|m4a|webm)(?:[?#]|$)',

  // Generic numbered stream segments (seg5 / segment-5 / chunk_5 / frag12 …).
  // A digit right after seg/segment/chunk/frag is a strong "HLS/DASH fragment"
  // signal — never a standalone file — so these would only ever fan out junk
  // entries + wasted probes. The leading '/' keeps it from matching mid-word
  // (e.g. 'message5.ts' won't match).
  '\\/seg(?:ment)?[-_]?\\d+\\.(ts|m4s|mp4|aac)(?:[?#]|$)',
  '\\/chunk[-_]?\\d+\\.(ts|m4s|mp4)(?:[?#]|$)',
  '\\/frag(?:ment)?[-_]?\\d+\\.(ts|m4s|mp4)(?:[?#]|$)',

  // Disguised-HLS segments — sites like series.ly serve a real HLS stream
  // whose .ts segments are uploaded to TikTok's *ad-image* CDN under a
  // ".image" pseudo-extension (…tplv-d5opwmad15-ttam-origin.image) and
  // delivered as image/png. The page's hls.js fetches each segment during
  // preview, so the generic catcher (which classifies on the image/png
  // content-type) captures every one as a standalone image — junk "frames"
  // (e.g. 875x369, even carrying a CC track, because the bytes are really
  // mpegts video). The actual stream is the .m3u8, captured as a single video
  // once ffmpeg's extension_picky is off (see utils_set_dict_options). Block
  // the segments so only the playlist is captured. Scoped to the ad-site CDN
  // path: it never matches TikTok's own webapp-prime video media, which is
  // deliberately left un-blocked for first-/foryou capture.
  'tiktokcdn\\.com\\/ad-site-i18n[^?]*\\.image',

  // Other
  'startpage\\.com\\/sp\\/cl',
  'rumble\\.com\\/service\\.php\\?name=video\\.watching-now',
  'midjourney\\.com\\/cdn-cgi\\/challenge-platform',
  '\\/cdn-cgi\\/challenge-platform\\/',
  '.*segment\\.init',
];

let combinedRegex = buildRegex(DEFAULT_PATTERNS);

/**
 * Build a single RegExp from an array of pattern strings.
 * Blank lines and lines starting with # are ignored.
 */
function buildRegex(patterns) {
  const filtered = patterns
    .map(p => p.trim())
    .filter(p => p && !p.startsWith('#'));
  if (filtered.length === 0) return null;
  return new RegExp(filtered.join('|'));
}

/**
 * Fetch patterns from remote, recompile regex.
 * Falls back silently to current regex on any error.
 */
async function refreshPatterns() {
  try {
    const res = await fetch(REGEX_URL, { cache: 'no-cache' });
    if (!res.ok) {
      if (DEBUG) console.warn(`[regex] Remote fetch failed: ${res.status}`);
      return;
    }
    const text = await res.text();
    const lines = text.split('\n');
    const newRegex = buildRegex(lines);
    if (newRegex) {
      combinedRegex = newRegex;
      if (DEBUG) console.log(`[regex] Updated ${lines.filter(l => l.trim() && !l.trim().startsWith('#')).length} patterns from remote`);
    }
  } catch (e) {
    if (DEBUG) console.warn('[regex] Remote fetch error:', e.message);
  }
}

// Initial fetch + periodic refresh
refreshPatterns();
setInterval(refreshPatterns, REFRESH_INTERVAL_MS);

/**
 * Test a URL against the combined exclusion regex.
 */
function matchInRegex(string) {
  return combinedRegex ? combinedRegex.test(string) : false;
}

export { matchInRegex };
