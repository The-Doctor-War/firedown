// Declarative, per-parser media block-list for the generic catcher.
//
// THE CARDINAL RULE (see CLAUDE.md "Parser vs. generic catcher"): a site that
// has a dedicated parser in the `parser@` extension must be captured BY that
// parser — which emits rich metadata + quality variants — and NOT by this
// generic catcher (`downloader@`), which would emit a second, bare,
// metadata-less entry for the same video (a duplicate) and waste a
// `metadatareader` probe on it.
//
// To enforce that, every parser's emitted media URL (and the segments its
// player fetches for that media) is block-listed here, by host/CDN.
// `validateAndClassify` in requests.js tests this list BEFORE classifying or
// probing a URL and drops a match.
//
// WHY A SEPARATE FILE FROM regex.js. regex.js holds the generic, CDN-agnostic
// junk (telemetry/beacon endpoints, init/numbered HLS-DASH segment fragments)
// and is REMOTE-MANAGED — its pattern list is refetched every 6h. The
// parser-dedup blocks are different in kind: they're bundled-only, they pair
// 1:1 with a parser in the other extension, and they change when a parser
// changes. Keeping them here, keyed by parser, makes the cardinal rule
// mechanical — adding or changing a parser means adding/adjusting its entry
// HERE, next to nothing else, instead of threading another line into the
// remote-managed generic list.
//
// HOW TO ADD A PARSER: drop a new key below with the host/CDN pattern(s) for the
// media that parser emits. Each value is a JS-regex SOURCE string (the same
// dialect regex.js uses), tested against the full URL. Pick a pattern that
// matches exactly what the parser emits (plus the segments its player fetches),
// but is narrow enough not to swallow unrelated media on a shared CDN.
//
// NOTE: TikTok is deliberately ABSENT. Its `webapp-prime` media host is left
// un-blocked on purpose so the generic catcher can grab the cache-served first
// /foryou video the parser structurally cannot see (see the TikTok note in
// CLAUDE.md). Do not add a TikTok media block here.

const PARSER_BLOCKLIST = {
  // Twitter / X — progressive + HLS on video.twimg.com; pscp.tv (Periscope)
  // audio for Spaces / live.
  twitter: [
    'video\\.twimg\\.com.*\\.(mp4|m4s|m3u8)',
    'pscp\\.tv.*\\.aac',
  ],

  // Instagram + Threads — same fbcdn hosts, so one rule covers both.
  instagram: [
    'instagram.*\\.mp4',
  ],

  // Bilibili.tv — the DASH video+audio .m4s baseUrls the page-state bridge emits
  // on the upos/bilivideo bstar CDN (iupxcodeboss path).
  bilibili: [
    'upos-.*(bilivideo\\.com|akamaized\\.net)\\/iupxcodeboss\\/.*\\.m4s',
  ],

  // Niconico — the signed HLS master is emitted from access-rights/hls; block
  // the delivery.domand playlists (master/media .m3u8) and the CMAF media on the
  // asset CDN (per-track init01.cmfv / init01.cmfa + data .cmfv / .cmfa
  // segments) so the catcher doesn't grab the bare master or the init segments
  // as standalone (unplayable) entries.
  niconico: [
    'delivery\\.domand\\.nicovideo\\.jp\\/.*\\.m3u8',
    'asset\\.domand\\.nicovideo\\.jp\\/.*\\.cmf[va]',
  ],

  // Dailymotion — the init segment, the media playlist, and the signed manifest
  // the parser emits (the manifest carries a #fragment, so there's no extension
  // anchor on the path).
  dailymotion: [
    'dmcdn\\.net.*init\\.mp4',
    'dmcdn\\.net.*manifest\\.m3u8',
    'dailymotion\\.com\\/cdn\\/manifest\\/video\\/.*\\.m3u8',
  ],

  // Twitch — the HLS master/media + segments the parser enumerates: ttvnw.net,
  // the live-video.net IVS edges (playlist/playback), and the cloudfront VOD
  // index playlists (index-dvr / index-muted).
  twitch: [
    '(ttvnw\\.net|hls\\.live-video).*\\.(m3u8|ts)',
    'cloudfront\\.hls\\.ttvnw\\.net\\/v1\\/segment.*',
    'twitchcdn.*\\.mp4',
    'cloudfront\\.net\\/.*\\/(index-dvr|index-muted-[^.]+)\\.m3u8',
    '(playlist|playback)\\.live-video\\.net.*\\.m3u8',
  ],

  // Rumble — the parser emits the HLS master (watch pages, via embedJS) and the
  // MP4 shorts variants on the rumble.cloud CDN.
  rumble: [
    'rumble\\.com\\/hls-vod\\/.*\\.m3u8',
    'rumble\\.cloud\\/.*\\.mp4',
  ],

  // Mega.nz — the page-state bridge captures folder-link files (the share key is
  // page-world only) and the native MegaStrategy resolves + decrypts them. Block
  // the encrypted-byte download hosts (gfs*.[userstorage.]mega.co.nz) so the
  // generic catcher can't emit a second, bare, AES-CTR-ciphertext entry that no
  // amount of re-fetching could ever decrypt. (Playback is unaffected — the
  // block-list only governs capture, not the page's own requests.)
  mega: [
    'gfs[^/.]*\\.(userstorage\\.)?mega\\.co\\.nz\\/',
  ],

  // Tube8 / Pornhub-network family (tube8, pornhub, youporn, redtube, white-label
  // clones). These are captured by the GENERIC page-state bridge
  // (readPlayerMedia → resolves the …/media/mp4/?s= JSON delegate, emits the
  // progressive .mp4 / .m3u8 on the t8cdn/phncdn/ypncdn/rdtcdn media CDNs). The
  // bridge is host-agnostic, but dedup against the play-time wire capture is not:
  // the played URL dedups by URL against the parser entity for the DEFAULT
  // quality, but a manually-selected OTHER quality has a URL the parser emitted as
  // a non-primary variant — so for this known, high-traffic CDN family we block
  // its media here to suppress that duplicate. Other (un-listed) sites the bridge
  // handles rely on the URL dedup alone. Scoped to the media extension so it never
  // swallows the thumbnails these same CDNs serve (.jpg).
  pornhubNetwork: [
    '(t8cdn|phncdn|ypncdn|rdtcdn)\\.com\\/.*\\.(mp4|m3u8)',
  ],

  // YouTube — fully owned by the youtube@ parser (VOD = SABR, LIVE = HLS master,
  // both emitted with rich metadata + quality variants). Unlike the shared CDNs
  // above this is a HOST-level block: googlevideo.com is YouTube's EXCLUSIVE media
  // CDN (no unrelated media lives there), so scoping to an extension would only
  // risk missing one of YouTube's many URL shapes. The generic catcher must never
  // emit a googlevideo entry.
  //
  // The load-bearing case is LIVE. VOD is SABR (videoplayback chunks, no manifest
  // URL the catcher classifies as media), so it never tripped. But a live stream
  // plays over HLS, so a clean .m3u8 crosses the wire —
  // manifest.googlevideo.com/.../hls_variant/ (master) and .../hls_playlist/
  // (child) — which the catcher grabbed and emitted as type:"media". That fired a
  // metadatareader probe that opened the live segments on the rr*.googlevideo
  // chunk hosts, every one 403ing on the per-host n-param / live edge, spinning
  // ffmpeg's reload loop until the hls.c patch-0005 bail. This block drops the
  // capture before classify, so no probe. (The youtube@ parser separately emits
  // the master as type:"hls-master" → native enumerates the master text only, no
  // probe — these two together close both probe sources for live.)
  youtube: [
    'googlevideo\\.com\\/',
  ],
};

// Flatten every parser's patterns into one compiled RegExp — same approach and
// dialect as regex.js's buildRegex (an alternation of the source strings). Built
// once at module load; the list is bundled (not remote), so it never changes at
// runtime.
function buildParserRegex(map) {
  const all = [];
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length; i++) {
    const list = map[keys[i]];
    for (let j = 0; j < list.length; j++) {
      all.push(list[j]);
    }
  }
  if (all.length === 0) return null;
  return new RegExp(all.join('|'));
}

const parserBlockRegex = buildParserRegex(PARSER_BLOCKLIST);

/**
 * True when the URL is a parser-owned media URL the generic catcher must not
 * capture/probe (the cardinal rule). Mirrors regex.js matchInRegex semantics.
 */
function matchInParserBlocklist(string) {
  return parserBlockRegex ? parserBlockRegex.test(string) : false;
}

export { PARSER_BLOCKLIST, matchInParserBlocklist };
