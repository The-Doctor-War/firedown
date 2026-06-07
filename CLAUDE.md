# CLAUDE.md

Guidance for Claude (and other agents) working in this repo. Read this before
touching the media parsers or debugging "video not picked up" issues.

## What Firedown is

Android browser + downloader built on **GeckoView** (not Chromium), with
uBlock Origin. Media capture is done by a set of **built-in WebExtensions**
bundled as assets and loaded via `GeckoRuntimeHelper.registerBuiltIn(...)`
(`app/src/main/java/com/solarized/firedown/geckoview/GeckoRuntimeHelper.java`).

### The extensions (`app/src/main/assets/`)

| dir           | id                       | role |
|---------------|--------------------------|------|
| `parser/`     | `parser@solarized.dev`   | Per-site parsers (Twitter/X, Instagram, Threads, Facebook, Vimeo, Rumble, Bilibili.tv, Niconico, Kick, Twitch, Dailymotion, Apple Podcasts, TikTok). Emits download entries **with metadata** (title, author, thumbnail, duration, multiple quality variants). |
| `webrequests/`| `downloader@solarized.dev` | **Generic** catch-all. Captures any media URL (`.mp4`, `.m3u8`, `.mpd`, …) seen on the wire. Has **no rich metadata** — just the URL + whatever `og:`/JSON-LD the content script scrapes. |
| `youtube/`    | `youtube@solarized.dev`  | YouTube (separate; uses `PoTokenGenerator` on the Java side). |
| `ublock/`     | uBlock Origin            | Ad blocking. |
| `icons/`, `search/`, `db/`, `error/` | — | Support. |

Native bridge: extensions call `browser.runtime.sendNativeMessage("parser", …)`
and emit captures via `sendNative(...)`; Java handles them in
`GeckoRuntimeHelper.handleExtractionMessage` / `GeckoInspectTask`.

## Parser vs. generic catcher — the cardinal rule

**A site that has a dedicated parser must be captured by the parser, NOT the
generic catcher.** The two are mutually exclusive *by design*:

- The parser gives metadata + quality variants. The generic catcher gives a
  bare URL.
- To stop them both firing on the same video (which produces a **duplicate**
  download entry), the site's media URL is **block-listed** in
  `app/src/main/assets/webrequests/js/regex.js`. Examples already there:
  `instagram.*\.mp4` (covers Instagram **and** Threads — same fbcdn hosts),
  `video\.twimg\.com.*\.(mp4|m4s|m3u8)` (Twitter/X).

Consequences when working on a parser:

- **MANDATORY: every new or changed parser MUST add a matching block rule to
  `app/src/main/assets/webrequests/js/regex.js` for the media URL(s) it emits.**
  Without it, the generic catcher *also* captures the same media and you get a
  duplicate download entry (one rich from the parser, one bare from the
  catcher). Adding a parser is not done until its block rule exists. Examples:
  - Instagram/Threads → `instagram.*\.mp4`
  - Twitter/X → `video\.twimg\.com.*\.(mp4|m4s|m3u8)`
  - Rumble → `rumble\.com\/hls-vod\/.*\.m3u8` (the HLS master the parser emits)
  - Bilibili.tv → `upos-.*(bilivideo\.com|akamaized\.net)\/iupxcodeboss\/.*\.m4s`
  Pick the pattern that matches exactly what the parser emits (and the segments
  the player fetches for it), but is narrow enough not to swallow unrelated media.

Some parsers read the page's own JS state instead of a network response —
**Bilibili.tv** is the example: the play page SSR-inlines the playurl into
`window.__initialState` (a devalue IIFE) and fires no playurl XHR, so it can be
read **only** from the page world. This is handled by the **generic page-state
bridge** (see below), not a per-site script: the bridge finds
`player.playUrl.dash.{video,audio}` and emits the two whole-track `.m4s` baseUrls
(DASH SegmentBase — each baseUrl is one complete track byte-range-fetched, *not*
a segment list) as video+audio variants, which `FFmpegMergeStrategy` muxes
natively (no ffmpeg.wasm).

### Page-world state — the generic `wrappedJSObject` bridge (no per-site scripts)

When a site inlines the playable media into a page-world JS global
(`window.__initialState`, `__NEXT_DATA__`, `__NUXT__`, a Redux/Apollo store, a
devalue blob …) and fires **no** playurl XHR, neither the wire nor the DOM can
see it — only page-world JS can. **Do NOT add a per-site content-script + WAR
inject pair for this** (the old Bilibili.tv approach, since removed). One
catch-all content script, `parser/page-state-bridge.js`, matched on
**`<all_urls>`** (so it needs **no per-site `matches` and no host permissions**),
covers every such site:

- It reads the page's real globals via Firefox's Xray **`window.wrappedJSObject`**
  waiver — the same mechanism `youtube/content.js` (PoToken `eval`) and
  `webrequests/content-script.js` already rely on in this GeckoView, so it's
  confirmed to work. **No `<script>` inject, no web-accessible resource, no
  page-CSP problem.**
- It runs a **bounded** generic search (`findDash`, depth/node-capped) for a DASH
  `{video[],audio[]}` slice, **copies it to plain data** with index loops
  (Xray-waived page arrays misbehave with `.some`/`.map`/`.filter` callbacks —
  use direct reads), builds video+audio variants, and posts them to the
  background.
- Background `kind:"page-state-media"` → `sendVariants` with a **generic** Referer
  = the page origin (covers bilibili's upos/bilivideo anti-leech without any
  per-site host check). Per-site **request/emit** specifics belong in
  `background.js`, never as new injected files.
- Cheap on the ~all sites with no such state: it probes a short list of known
  state-global names and no-ops when none hold media; the persistent SPA-nav
  observer is armed **only after** a successful capture.

**Metadata: generic by default, host-keyed when richer fields exist in page
state.** `resolveMeta(root)` defaults to `og:title`/`document.title` + `og:image`;
a known host overrides it with a branch **in the bridge** (e.g. Bilibili.tv reads
`root.ogv` for the episode-precise `Season Episode` title + per-episode cover).
That branch lives in the bridge — **not** `background.js` — because the bridge is
the only place that holds the page-world `root`; the background can't read page
state. Adding a host here is still **not** a new content script. Reads in such a
branch must be index-loop / primitive only (Xray-waived page arrays misbehave
with iterator/callback methods). A site still needs its `regex.js` block rule for
the media it emits (Bilibili.tv's `.m4s` rule is unchanged), same cardinal rule
as any parser.
- **Do not** "fix" a missing capture by removing/bypassing the regex block so
  the generic catcher grabs it. That reintroduces the duplicate and drops
  metadata. Fix the **parser** instead.
- That regex list is **remote-managed** (fetched from
  `firedown-webrequests/main/regex-patterns.txt` every 6h); `DEFAULT_PATTERNS`
  in `regex.js` is only the bundled fallback. Logic changes in `requests.js`
  ship in the APK; pattern changes generally belong in the remote list — so add
  the rule to **both** the bundled `DEFAULT_PATTERNS` (covers fresh installs /
  remote-fetch failures) **and** the remote `regex-patterns.txt` (governs
  production once fetched).

### HLS-master sites — Java enumeration, no ffmpeg probe

niconico, Twitch and Kick emit `type:"hls-master"` from the parser
(`enumerateMasterNative` in `background.js`). `GeckoInspectTask.processHlsMaster`
fetches the master with native OkHttp (`WebUtils.getString` — can set
Origin/Referer/Cookie, unlike a page `fetch()`), enumerates qualities with
`M3U8Parser.parseMaster` (text only — never opens a segment), and runs them
through `VariantProcessor` with `skipProbe=true`. So capture neither runs the
ffmpeg `metadatareader` probe nor decrypts anything — which for niconico avoids
burning the single-use AES key at capture time (see Niconico below). Routed via
`UrlType.HLS_MASTER`; still needs a `regex.js` block rule like any parser; and
the capture is **deduped on the page origin** (a fresh signed master URL per
refresh would otherwise create duplicate entries) via `entity.setUid` in
`GeckoInspectTask`.

### Skip the capture probe when the parser already has the metadata

A parser that supplies url + resolution + duration does **not** need the ffmpeg
`metadatareader` probe — the only extra it yields is codecs, which are read
nowhere downstream (`getVideoCodec`/`getAudioCodec` live only inside
`VariantProcessor`). Don't add a probe just for codecs. How each shape skips:

- **Progressive variants** (Twitter/Instagram/Threads/Facebook/TikTok/Rumble-mp4):
  `sendVariants` auto-sets `skipProbe` when there's a `duration` and no per-variant
  `audioUrl`. Separate-audio (Bilibili DASH) is **excluded** — it still probes.
- **HLS masters** (Vimeo/Dailymotion/niconico/Twitch/Kick/Rumble-HLS): emit via
  `enumerateMasterNative` (`type:"hls-master"`), **never** `type:"media"` (which
  probes). The callee owns origin dedup — callers must NOT also `markSent`.
- **Audio** (Apple Podcasts): `type:"media"` + `skipProbe` (gated on duration) →
  `GeckoInspectTask.processMediaSkipProbe`; audio-only, falls back to the probe if
  the URL mime isn't recognisably audio (so an extensionless enclosure can't be
  misclassified).

`VariantProcessor`'s skipProbe branch sets the entity **type**: default **FILE**
(raw byte-exact `HttpDownloadStrategy`), **MEDIA** (ffmpeg) for a separate-audio
pair or a **declared** manifest — see "Manifest vs progressive — declared, never
URL-sniffed" under Downloading. Default is progressive so tokenized URLs (TikTok)
carry no `.mp4` and aren't needlessly remuxed.

### Post-download metadata backfill (when capture skipped the probe)

`DownloadTask.backfillMetadataIfMissing()` (called from `onRunComplete` on a
FINISHED download) stamps the **secondary metadatum** the Downloads UI shows when
it's absent — probing the **finished local file** once (cheap, no network, no
keys), so it never burns a single-use key the way a capture-time probe would. Two
gaps reach it:

- **Duration** (audio/video) — HLS-master captures (Twitch/Kick/niconico) skip
  the capture probe and the master carries no duration, so a selected
  audio-only rendition finishes with none.
- **Resolution** (image/SVG) — an image saved via the browser long-press menu
  ("save image", `BrowserFragment`) is a bare `DownloadRequest` (url + name +
  cookies); it never goes through the parser/`VariantProcessor`, so it has no
  resolution and the list/info row would render a blank resolution tag.

It only probes when the field for the entity's **type** is actually missing
(mime resolved by then via `HttpDownloadStrategy.onMimeResolved`). Resolution
reuses `FFmpegMetaDataReader.getStreams()` so the `"WxH"` / SVG-encoded-size
formatting matches the parser path exactly. Don't widen this into an
unconditional probe — it's a targeted backfill, not a second capture probe.

### HTML character references in scraped titles/descriptions

Captured metadata can carry HTML character references **verbatim** — most
notably from **JSON-LD**: the HTML parser treats a
`<script type="application/ld+json">` body as *raw text* and does **not** resolve
references inside it, so `JSON.parse` keeps `&#x41c;` (М) / `&amp;` literal and it
flows into the stored name/description (the info Downloads dialog then shows it
raw). `og:`/`twitter:` meta read via `getAttribute('content')` are already
decoded by the DOM, so this is a JSON-LD/JSON-source problem, not a meta-tag one.
Two layers, both best-effort with a **raw-text fallback** on error:

- **`parser/background.js` `decodeHtmlEntities`** — decimal `&#NNN;`, hex
  `&#xHHH;`, and the named refs that appear in titles/descriptions; applied to
  `name`/`description` at the emit choke points (`sendVariants`,
  `enumerateMasterNative`, `emitHlsMasterOrSingle`). Idempotent; unknown refs
  left untouched.
- **`InfoAdapter` `decodeHtml`** — display-layer catch-all via
  `HtmlCompat.fromHtml(FROM_HTML_MODE_LEGACY)` on the description field, so the
  generic catcher's JSON-LD descriptions (which never pass the parser emit) are
  covered too. `stripHtml` only strips tags/whitespace — it does **not** decode
  entities; don't conflate the two.

### YouTube / SABR

YouTube isn't HLS/DASH — it's Google's SABR (itag formats, a
`serverAbrStreamingUrl` + ustreamer config, and a PoToken minted by BotGuard via
`PoTokenGenerator`). The `youtube@` extension emits adaptive video+audio
itag-pair variants + the shared SABR data; routed via `UrlType.SABR`, downloaded
by `SabrStrategy`. `VariantProcessor` skips ffprobe for SABR variants (empty
media URLs) and trusts the JS codec/resolution/duration. Captions use the
separate `timedtext` path.

### TikTok — filterResponseData (item_list feeds + document SSR)

TikTok capture is entirely on the wire/document side — **two** `filterResponseData`
producers in `background.js`, both feeding `handleTikTokItemList`. There is **no
TikTok content script** (it was deleted — `filterResponseData` covers capture, and
the Take-A-Break dismissal it used to do was dropped with it; see the throttle
note below).

1. **item_list XHRs — `filterResponseData` on `/api/*/item_list/`**: a passive
   `onBeforeRequest` listener reads the page's OWN response **byte-exact**
   (`filterResponseText` writes every chunk straight through — no refetch, so the
   single-use `msToken`/`X-Bogus` signing is untouched). Covers FYP, profile,
   hashtag/challenge, `/related/`, and `/newtab/`. Only viable because the
   geckoview **ServiceWorker-visibility patch (0006)** makes SW-synthesized
   responses fire `http-on-examine-response`, so `filterResponseData` now reaches
   the SW-served `/related/item_list/` feeds that were once untappable.
2. **Document SSR — `filterResponseData` on the `main_frame` HTML, DETAIL pages
   only**: `/@user/video/<id>` detail pages inline the video into the document's
   `__UNIVERSAL_DATA_FOR_REHYDRATION__` blob (under
   `webapp.video-detail`/`webapp.reflow.video.detail`) and fire **no** item_list
   XHR, so there's nothing else to tap. `extractTikTokSSRItems` pulls the blob from
   the HTML (`TIKTOK_REHYDRATION_RE`) and returns the single detail item to
   `handleTikTokItemList`. **Read the document RESPONSE, not the DOM** — raw bytes
   are immune to React stripping the rehydration `<script>` during hydration (the
   Threads "read the network response, not the DOM" lesson). If the document is
   SW-synthesized, 0006 is again what makes it tappable. The listener is gated to
   `TIKTOK_DETAIL_PATH_RE` — it does **not** run on `/foryou`, because the feed
   document's blob holds **no** video (**proven on-device**: only
   `webapp.app-context`/`i18n`/`biz`/`seo` scopes); the FYP feed is fully
   client-rendered. Don't re-add a `/foryou` branch — it would just read ~165 KB
   per load to find nothing.

**The first `/foryou` video — generic catcher, NOT the parser (deliberate
cardinal-rule exception).** TikTok renders the first FYP video from its **own
client-side cache**, so that video's metadata **never crosses the wire** — it's in
neither the document SSR (feed blob has no video, above) nor any item_list XHR
(verified from a HAR: the first-played storage id was in *neither* recommend nor
preload, only in the media fetch). So the parser structurally **cannot** capture
it. The decision (maintainer's call) is to let the **generic catcher**
(`downloader@`) grab it: TikTok's `webapp-prime` media host is **deliberately NOT
block-listed in `regex.js`** — the one parser-owned site without a media block, on
purpose. **Do not re-add a `webapp-prime`/`tiktokcdn` block rule** — it would
re-break first-video capture. Trade-off accepted: because the block is gone, the
generic catcher can also capture the *swipe* videos' media (which the parser
already has rich), so duplicates are possible where the played URL differs from
the parser's emitted variant URL (`BrowserDownloadRepository.isPresent` only
collapses exact/trivially-different URLs). A storage-id-gated media fallback that
captured *only* the uncaptured video was built and then **removed** at the
maintainer's request — don't reintroduce it.

**History — the page-world inject was retired.** TikTok capture *used* to depend
on a page-world inject (`tiktok-inject.js`, a moz-extension WAR hooking
`window.fetch`/`XMLHttpRequest`) because three things blocked `filterResponseData`:
refetch tripping `msToken`/`X-Bogus` (N/A to a passive read), SW-served feeds
being untappable (fixed by 0006), and a fear that the stream perturbation tripped
the "Something went wrong" overlay. That last one **did not reproduce on-device**
with byte-exact write-through, so the inject + its postMessage bridge were
removed. The detail-page SSR read *also* started in the content script
(`captureVideoDetailSSR`, DOM) but moved to the `main_frame` document filter (2.).
Don't reintroduce the inject, and don't move SSR reading back to the DOM.

- **The item_list PAT must allow sub-segments.** A hashtag page fires
  `/api/challenge/item_list/?…` AND `/api/challenge/item_list/newtab/?…`; the
  regex is `\/api\/[a-z_]+\/item_list(?:\/[a-z_]+)*\/?\?` so the `/newtab/` feed
  (≈half the videos) isn't dropped.
- **Tag/challenge pages SSR no video data** (the rehydration blob is only
  app/i18n/seo context) — the feed is client-rendered via the item_list XHRs, so
  the item_list listener is the only source there. The `main_frame` SSR listener
  runs on the detail (`/@user/video/<id>`) paths only.
- **The anti-bot throttle is the real gotcha.** TikTok withholds the item_list
  XHRs entirely (the `Take_A_Break` reminder shows, only `/api/preload/` fires)
  unless the page's **fingerprint stays unstable**. Globally that's
  `privacy.resistFingerprinting` — a user toggle that ships OFF and degrades
  every site. The previous mitigation was a per-site FPP override
  (`GeckoRuntimeHelper.applyTikTokFingerprintingOverride`) that scoped
  `+CanvasRandomization` to first-party `tiktok.com` via
  `privacy.fingerprintingProtection.granularOverrides` so the canvas readback
  noised per session and the fingerprint never stabilised (the read still
  succeeded — `+AllTargets` was the wrong knob: it enables the canvas-extraction
  *blocking* targets, breaking `webmssdk`'s read → "Something went wrong").
  **That override was REMOVED at the maintainer's request** (commit on
  `claude/happy-fermi-VY4tV`). Consequence to be aware of: with no per-site
  randomization, the throttle can re-engage and the item_list feeds may stop
  firing on some loads — which starves **both** capture sources (the inject and
  the new `filterResponseData` path), since neither can read a request the page
  never makes. The ServiceWorker-visibility patch (0006) does **not** help here
  — the throttle is server-side, not a response-visibility problem. If TikTok
  capture regresses to only `/api/preload/`, this removal is the first suspect;
  the fix is a *randomizing* (never blocking) FPP vector scoped to tiktok.com,
  not global RFP and not `+AllTargets`. **The `Take_A_Break` overlay is also no
  longer auto-dismissed** — the content script that did it was deleted (capture is
  all `filterResponseData` now). The overlay visually suppresses `/api/*` until
  closed, so if it mounts, feeds pause until the user dismisses it manually. If
  this becomes a problem, prefer a DOM-only dismissal — a content script that does
  *only* that, not capture — over reviving any page-world inject.

### Capture dedup

Three layers prevent duplicate entries for one video:
- **regex block** (cardinal rule) — keeps the generic catcher off a parser's media;
- **JS `sentOrigins`** (`background.js`) — per page origin, 30s TTL;
- **`BrowserDownloadRepository.isPresent`** — per `tabId`, then `uid` /
  exact-or-trivially-different URL / image perceptual hash. `uid` is
  `url.hashCode()`, except **HLS_MASTER** keys it on the page origin (signed
  master URLs rotate per refresh).

### Capture "scanning" indicator

`PriorityTaskThreadPoolExecutor` exposes an in-flight task count
(`getInFlight()` — incremented at submit, decremented in the run `finally` so
aborts count too). `BrowserOptionFragment` observes it via
`BrowserDownloadViewModel.getInflight()` and shows a small brand-orange spinner
next to the grid/list toggle whenever busy — debounced (show-now + ~500 ms
hide-linger so it doesn't strobe; decoupled from the filter chips, so filtering
to an empty type doesn't hide it). The empty list uses the LCEE loading spinner.
Fills the gap where a slow capture (e.g. an HLS-master fetch) makes the sheet
look empty for seconds.

### Inspect task scheduling (`PriorityTaskThreadPoolExecutor`)

Captures run on a small priority pool. Each task carries a **base** priority
(urlType-derived — `HIGH`=1 for media/SABR/HLS_MASTER, `NORMAL`=10 for
image/SVG, `LOW`=100 for everything generic) plus its `tabId`; the executor
demotes it to `PRIORITY_BACKGROUND` (1000) unless its tab is the **current** one
(`-1`/unknown = treat as foreground). The demotion floor is **below every base
priority on purpose**: generic captures are already `LOW`, so flooring the
backlog at `LOW` too would let a tab you just switched into (whose own captures
are also `LOW`) merely *tie* with the previous tab's 200-item backlog — its new
captures would still wait behind them. `PRIORITY_BACKGROUND` is a level no
foreground task can hold, so the current tab's work always runs first regardless
of base. (Background tasks all share that one floor — relative order among them
is intentionally flat; what matters is foreground-beats-background.) Two mutators
keep the backlog relevant while browsing:

- **`setCurrentTab(tabId)`** (from `GeckoRuntimeHelper` onActivated/onUpdated)
  re-prioritizes the **whole pending queue** — drain → recompute each task's
  effective priority → re-offer (a `PriorityBlockingQueue` can't re-heapify in
  place when the comparator's external input changes) — so a tab you switch to
  jumps ahead of a heavy background tab's backlog.
- **`cancelTab(tabId)`** (onRemoved, beside `trimTabs`) drops a closed tab's
  queued tasks so they don't saturate the pool, decrementing the in-flight count
  per removed task.

Both are `synchronized` on the **same monitor** as `executeWaitingTask`, so a
switch and a close can't interleave (consistent queue + correct in-flight count
in either order) and the drain window can't be observed by a poll. `execute()`'s
offer stays lock-free (the queue is thread-safe; a task offered mid-drain just
coexists with the re-offered ones). Running tasks are never interrupted —
priority/cancellation only affect the *queued* tasks.

Pool sizing: `NETWORK_CORE_POOL_SIZE = max(1, cores/2)` drives **both** the
thread pool and the submit gate, and `executeWaitingTask` submits while
`poolAvailable > 0` — i.e. **every** thread is usable. Don't reintroduce the old
`> 1` gate (it reserved one thread for a cancellation task that doesn't exist —
`cancelTab` runs synchronously on the caller): it left a thread permanently idle,
**halved** throughput on 4-core devices, and on a 2-core device (pool size 1)
stalled the pool entirely (`poolAvailable` never exceeded 1). The `max(1, …)`
floor also avoids `newFixedThreadPool(0)` throwing on a single-core device.
`cancelTab` deliberately does **not** reset `currentTabId` — closing the
foreground tab leaves it dangling only until the next `onActivated →
setCurrentTab` (always fired, bar closing the last tab, after which no captures
flow); resetting to `-1` would treat every task as foreground and surge a
background tab's backlog back to base priority.

## Debugging "video not captured" — do this, in order

This section exists because a Threads bug took ~8 rounds that should have taken
1. The failure mode was **theorizing about the transport while never running
   the actual extraction code against the bytes we already had.**

1. **Confirm it's a debug build.** All parser logs are gated on
   `BuildConfig.DEBUG`. The extension fetches it at boot via
   `get-debug-flag` (`background.js` top; answered in
   `GeckoRuntimeHelper` ~line 322). Release builds log nothing.

2. **Read the logs by category.** `adb logcat -s GeckoConsole:*` then grep the
   prefix: `TWITTER`, `INSTAGRAM`, `THREADS`, `THREADS-CS`, `FB-*`, `IG-*`,
   `RUMBLE`, `TWITCH`, `KICK`, `VIMEO`, `DAILYMOTION`, `TIKTOK`, `VARIANTS`,
   `DEDUP`, `NATIVE`. The generic catcher logs under `[req]` (gated on its own
   `DEBUG`). Java-side variant probing is `VariantProcessor`.

3. **Get a HAR of the failing case** (the user can export one). Find the
   request that actually carries the video/metadata — search response bodies
   for `video_versions`, `playable_url`, `.mp4`, `.m3u8`.

4. **THE KEY STEP: reproduce the parser's *exact* algorithm against the HAR
   bytes — caps and all — before changing anything.** When output is empty but
   the input is present, the bug is almost always in extraction, not transport.
   - A throwaway verification script that uses an *uncapped* or *simplified*
     walk will "find" the item and **falsely exonerate** the extractor. Mirror
     the real code: same regex, same depth cap, same node budget, same field
     checks. (The Threads bug: items sat at JSON **depth 16–22**; the walk
     capped at `depth > 14` and bailed two levels short. The doc filter had
     been delivering the full HTML correctly for many rounds.)

5. **Only after** the extractor is ruled out, look at transport (did the
   listener fire? `filterResponseData` available? right `types`/url patterns?).

### Don'ts (each one cost a round on Threads)

- Don't assume `filterResponseData` on `main_frame` doesn't work in GeckoView —
  it does. (The first attempt only *looked* dead because of caching; see below.)
- Don't try to read inline page data (`<script data-sjs>` etc.) from a content
  script's DOM. Meta's bootstrap (`ServerJSPayloadListener.process`) **consumes
  those scripts the instant they parse**; by the time a content-script
  observer's microtask runs, the big blob is already empty/replaced. Read the
  **network response** (`filterResponseData`) instead.
- Don't try a content-script `fetch()` of the page to re-read it — JS can't set
  `Sec-Fetch-Dest: document` (forbidden header), so the server returns an
  emptied shell.
- Don't reach for a "logged-in vs logged-out" explanation without evidence; it
  was a red herring.

#### Threads has NO content script — two `filterResponseData` paths only

Threads capture lives entirely in `background.js`: `listenerThreadsPage`
(`main_frame` doc filter — reads the `<script data-sjs>` Relay blobs from the
**raw network response**, logged-in) + `listenerThreadsApi` (the GraphQL/`api/v1`
XHRs, logged-out / SPA). **No content script, no GeckoView patch** — stock
`filterResponseData` on the main_frame is all it takes. The old
`threads-content.js` (a `document_start` MutationObserver that snapshotted the
same `data-sjs` from the DOM) was **removed**: it only *duplicated* the doc
filter on initial load and captured nothing on SPA nav (it just logged). Its
header claim that "filterResponseData on main_frame never fired" was the caching
artifact above, not the truth. **Don't reintroduce a Threads content script** to
"fix" a missed capture — fix the doc/API filter or the media-walk depth cap
instead. The one case a content script alone could see (a *cached* main_frame
document, where the filter may not re-fire but the DOM parse still inserts the
scripts) is marginal for dynamic post pages and irrelevant to the in-app
browser's usual logged-out state.

## WebExtension loading & versioning (GeckoView gotcha)

`registerBuiltIn` → `WebExtensionController.ensureBuiltIn(uri, id)` caches the
extension **keyed by the manifest `version`**. If you change a manifest
(e.g. add **or remove** a `content_scripts` entry) but **don't bump
`parser/manifest.json`'s `version`**, an in-place app update
(`adb install -r`) keeps the old registration and your change silently doesn't
load — a *removed* content script keeps running, an added one never starts. To
force a re-register: **bump the version**, or do a clean **uninstall + install**
(which wipes the registration so any version reloads). Symptom of this trap: a
brand-new listener/content-script produces *no logs at all* (or a deleted one
still does).

## After changing a parser

- `node --check` the JS file(s) you touched.
- Re-run your HAR simulation with the **final** code (caps included) and confirm
  it finds the expected item(s) with `user`, `caption`, and `video_versions`.
- **Confirm the `regex.js` block rule exists** for the media this parser emits
  (see the cardinal rule above) — this is the #1 thing that gets forgotten and
  causes duplicate entries.
- Prefer one capture mechanism per site. Multiple (doc filter + API filter +
  content script) can all fire and, if origins differ, produce duplicate
  entries; origin-dedup (`sendVariants` `alreadySent`) only collapses identical
  origins.

## Logging discipline

**Every log statement — Java and JavaScript — must be gated behind the debug
flag. No unconditional logging ships.**

- **JavaScript (extensions):** never call `console.log`/`console.warn` directly.
  Use the extension's `log(...)` helper, which early-returns unless `DEBUG` is
  true. `DEBUG` is resolved at boot from the native `get-debug-flag` message,
  which returns `BuildConfig.DEBUG` (`GeckoRuntimeHelper`). So a release build
  logs nothing even though the JS contains `log(...)` calls. New parsers must
  route all logging through `log(category, message, data?)` with a short
  uppercase category (e.g. `RUMBLE`).
- **Java:** wrap log calls in `if (BuildConfig.DEBUG) { … }` (or an equivalent
  guarded helper). Do not leave bare `Log.d/​i/​w/​e` on hot paths in release.
- Rationale: this is a privacy/no-telemetry app — logs can contain URLs, titles,
  cookies-adjacent data. Release builds must be silent.

## Tabs, sessions & delegate callbacks (foreground-only UI)

A tab is a `GeckoState` (+ its `GeckoSession`), **not** a separate fragment.
There is normally **one** `BrowserFragment` (plus an incognito one) driving
every tab. Gecko delegates (`NavigationDelegate`, `PromptDelegate`,
`ContentDelegate`, …) are attached to **every** session in
`connectSession` — so a **background tab keeps firing callbacks** (page loads,
deeplinks, JS `alert`, `beforeunload`, …).

`GeckoComponents`'s delegates fan those out to observers via
`mGeckoObserverRegistry.notifyObservers(...)`, and the registry calls **every**
registered `BrowserFragment` with no tab filter. So anything that shows UI from
a callback must first confirm the event came from the **foreground** tab,
otherwise a background tab's dialog/prompt pops over whichever tab is visible.

**The mechanism already exists: `isCurrentGeckoState(geckoState)` in
`GeckoComponents` (compares to the active tab id).** Gate UI-raising
notifications with it — as `START`, `STOP`, `PROGRESS`, `SECURITY`,
`THUMBNAIL`, `MEDIA_*` already do, and now `LOAD_REQUEST` (the "open in app"
deeplink), `PLAYSTORE_REDIRECT`, and the `PROMPT_*` prompts.

- For navigation callbacks that return allow/deny (`onLoadRequest`,
  Play-Store redirect): still `return GeckoResult.deny()` for a background tab
  — just skip the `notifyObservers` so no dialog shows.
- For prompts that owe Gecko a `GeckoResult` (every `PromptDelegate` method —
  alert/button/text/choice/color/date/auth/file/beforeunload/repost): a
  background tab must **dismiss** (`return GeckoResult.fromValue(prompt.dismiss())`)
  rather than skip — skipping leaves Gecko waiting forever. The pattern is to
  extend the existing `if (geckoState == null)` dismiss path to
  `if (geckoState == null || !isCurrentGeckoState(geckoState))`. All current
  prompts already do this.
- `onContext` (long-press menu) is inherently foreground — only the visible
  session is in the `GeckoView` to receive the touch — so it needs no guard.

Symptom this prevents: the "open in app" dialog (or an alert/file picker) from
a *previous* tab appearing after you switch tabs (repro: open bilibili.com,
switch tab mid-load; it fires a `bilibili://` deeplink from the background).

### Media notification — start the service from the controller, not the UI

The `GeckoMediaPlaybackService` foreground notification is shown on a `MEDIA_PLAY`
intent. That intent must be sent by **`GeckoMediaController`** (which always knows
the truly-playing session and has seeded the metadata), **not** only by the gated
`BrowserFragment.onMediaPlay` observer. `GeckoComponents` fires that observer only
when `isCurrentGeckoState` is true at the instant GeckoView's `onPlay` arrives —
so an `onPlay` that beats the current-tab-id update (fresh start / restore-autoplay
/ resume / tab switch) was gated out with **no recovery** (`onMediaPosition` bails
when the service isn't running; `onMetadata` only updates), leaving media playing
with no notification. `onMediaPlay`/`onMediaPauseOrStop` call `refreshService()`
which starts/updates the service directly (the tell was that the controller already
*stopped* it directly via `stopService()` — only start was UI-delegated). So the
notification follows actual playback, including a background tab that autoplays.

## Downloading & networking

Two download paths, one shared OkHttp client (`NetworkModule`, with
`OriginInterceptor` — it derives **Origin from an existing Referer**, it does
not invent a Referer; Referer must come from the capture/emit layer).

**Filenames can contain periods** (a podcast titled `156. Valero y Juan`).
`FileUriHelper.checkFileExtension` only treats the tail after the last dot as an
extension when it actually looks like one (`isPlausibleExtension`: 1–4 chars,
alphanumeric, no whitespace) — don't revert to a naive `FilenameUtils` split or
such titles get truncated to their first segment (`156.mp3`).

- **Progressive HTTP — `HttpDownloadStrategy`.** Default request sends **no
  Range** (some servers require a range, others reject one). It **reacts to
  partial content**: if the body ends short of `Content-Length` — thrown
  "unexpected end of stream" *or* a clean early EOF — it re-requests
  `Range: bytes=<have>-` and appends until complete (bails on no-progress / a
  resume cap). One mechanism for CDN anti-leech truncation (e.g. Bilibili
  `upos/bilivideo` caps a plain 200 at ~1 MiB but serves 206 in full), chunked
  short reads, and mid-stream disconnects. Don't reintroduce an unconditional
  Range default — it's site-specific thinking and breaks range-hostile servers.
- **Streams (HLS/DASH/segments) — ffmpeg via `FFmpegOkhttp`.** ffmpeg's HTTP is
  **not** native `http.c`; it's bridged to our OkHttp client by `FFmpegOkhttp`
  (a custom AVIO handler). It already does Range/206 properly: accepts 206 as
  success, parses `Content-Range`, range-**chunks** large files, honours
  ffmpeg `offset`/`end_offset`, and falls back on 416. So the stream path was
  never affected by the progressive-download truncation bug — only
  `HttpDownloadStrategy` was.

Headers (incl. any backfilled `Referer`) flow from the capture layer
(`webrequests/requests.js` for the generic catcher, or a parser's
`requestHeaders`) into both paths via `context.getHeaders()`.

### Capture-layer headers & cookies (how a re-download authenticates)

A captured media URL is re-fetched later by the native downloader, so it must
carry the headers + cookies the browser's original request had or the CDN 403s
it. How each is obtained (current architecture):

- **Request headers — `webRequest` is the backbone.** `requests.js` listens on
  `onSendHeaders` (with `['requestHeaders']`) + `onHeadersReceived` and **caches
  the request headers keyed by URL** (`cacheHeaders`/`getCachedHeaders`). When a
  media URL is emitted, its cached headers ride along on the `sendNative` message.
  Entries are tagged **page-context vs extension-context** (`fromExtensionContext`):
  headers from a request the *extension itself* issued get `Origin`/`Referer`/
  `Sec-Fetch-*` **sanitized** (`sanitizeHeadersForPage`) so we don't leak the
  moz-extension origin; page-context headers are used as-is. `Referer` is
  backfilled from the page URL when absent.
- **Cookies — `browser.cookies.getAll`, NOT `document.cookie`.** Session/auth
  cookies are usually `HttpOnly`, invisible to page JS. `cookies.js`
  `handleCookieRequest` answers the native `getCookiesForUrl` message by calling
  `browser.cookies.getAll({url})` (privileged → **includes HttpOnly**) and
  returns a built `Cookie` header string. So cookies are pulled from the browser
  jar on the native side's request, not scraped from the page.
- For headers on **content-script-discovered** URLs (next section), see the
  `HEAD`-probe backfill there.

The captured header set + cookie are reused for the whole stream — for HLS/DASH,
ffmpeg propagates them to every sub-request (master/playlist/segment/key); see
"Per-site request quirks" below.

### Three capture sources — wire, DOM, inject (webRequest is NOT enough alone)

The generic catcher has **two** sources, because `webRequest` alone misses media:

1. **Wire — `webRequest`** (`requests.js`): media fetched over HTTP. The backbone,
   and the only source that gets request headers + cookies "for free". But it
   **only fires for requests it actually observes** — it misses media that loaded
   from cache, before the listener attached, or that lives in a DOM attribute
   without a fresh request.
2. **DOM — content script** (`content-script.js`): scrapes the page for media the
   wire never showed. It reports `<img>` / `<source>` `src`/`srcset` **and
   `<video>`/`<audio>` `src`/`currentSrc`** URLs (with a `MutationObserver` on
   `src`/`srcset` for dynamically-added ones) to the background, **passively
   scrapes embedded media URLs from the page source** (see "Passive
   embedded-media scrape" below — this is what captures a video before the user
   presses play), and **separately scrapes JSON-LD `VideoObject` + `og:`/
   `twitter:` metadata** to enrich captures with accurate title/description (on
   video SPAs the `<title>`/`og:title` are usually the generic site name, so
   JSON-LD/`og:video:title` rank higher). A DOM-discovered URL has **no cached
   headers**, so `requests.js` does a `HEAD` `fetch(url, {credentials:'include',
   referrer: tab.url})` to populate the header cache via `onSendHeaders`, then
   forwards the (sanitized) result through the same emit path. So: content script
   *finds* it, the HEAD probe *authenticates* it.
3. **Page-world state** — read via the generic `wrappedJSObject` bridge
   (`parser/page-state-bridge.js`, `<all_urls>`), for media inlined into a page
   JS global with no XHR (Bilibili.tv). See "Page-world state — the generic
   `wrappedJSObject` bridge" above. This **replaced** per-site inject pairs;
   prefer `wrappedJSObject` from a content script over a `<script>`/WAR inject.
   (TikTok used an inject too, retired once `filterResponseData` + the 0006
   SW-visibility patch could read the feeds; see the TikTok section. A WAR inject
   is now only for what `wrappedJSObject` genuinely can't reach.)

**MSE / `blob:` is not special.** A `blob:` URL on a `<video>` is just a handle to
a `MediaSource`, never the download target — but MSE/HLS/DASH players still
`fetch`/XHR their manifest + segments over HTTP, so those are ordinary requests
the wire source already catches (and the content script catches `<source>`s). So
there's **no `blob:`-specific path**. An inject is only needed for what's
structurally invisible to *both* wire and DOM: ServiceWorker-*synthesized*
responses (the inject's `fetch`/XHR hook runs before the SW), segments assembled/
decrypted in JS with no network fetch, and single-use/signed URLs that capture
fine but can't be re-fetched (there you need the bytes, not the URL). Reach for an
inject only for those.

### Passive embedded-media scrape (capture without playback)

Many sites **inline the real progressive/HLS URL in the page source but only
*fetch* it on play** — so the wire source never fires and nothing is captured
until the user presses play. Example: El Periódico Mediterráneo
(`elperiodicomediterraneo.com`) ships the mp4 only inside
`window.dataLayer.push({video:{url:"…mp4"}})` — no `<source>` element, no
`og:video`, no playurl XHR. The content script's `scrapeEmbeddedMedia()` closes
this gap **passively** (no play needed), in two tiers:

- **Tier A (declared, low noise):** `<video>`/`<audio>` direct `src`,
  `og:video`/`og:video:secure_url`/`twitter:player:stream` meta tags (only when
  the content is itself a media-extension URL — an og:video that points at an
  embed *page* is left to the wire/HTML path), and JSON-LD
  `VideoObject.contentUrl` (`embedUrl` is a player page — skipped).
- **Tier B (targeted):** a media-extension URL inside an inline `<script>` that
  sits **next to a media-ish key** (`url`/`contentUrl`/`file`/`src`/`hls`/`dash`/
  `playable_url`/… — `SCRIPT_MEDIA_RE`). The key-proximity requirement is what
  makes the blind script scan targeted: it keeps us off the many unrelated
  absolute URLs in ad/analytics blobs, while the media extension itself already
  excludes most junk (a canonical page URL or poster `.jpg` next to `"url":`
  won't match). Handles escaped JSON slashes (`https:\/\/…`) and
  protocol-relative (`//host/…`) URLs. Bounded: a 4 MB total char budget, a
  40-URL/pass emit cap, and each inline script scanned at most once (`WeakSet`).

It runs at **DOMContentLoaded/load**, not `document_start` (the data lands during
parse) and **not on every mutation** (these SSR shapes are present at first load;
the element-level `scan()` + `MutationObserver` still cover SPA-injected
`<video>` nodes). Everything queued rides the **same `images-detected` path** as
DOM images: the background **reclassifies by extension** into a media capture
(`classifyByUrl`/`getTypeFromUrl`), **HEAD-probes** for headers/cookies, applies
the **parser block-list** (`matchInRegex` — so a parser-owned site doesn't get a
duplicate bare capture; the cardinal rule still holds), and the **repository
dedups** against a later wire capture if the user *does* play. So no new
transport, no Java changes — discovery only. On by default; the precision/noise
trade-off is held by the Tier-B key-proximity filter, not a setting.

This is **not** the "don't read inline `<script>` data from the DOM" Threads
anti-pattern: that warning is specifically about **Meta's bootstrap**
(`<script data-sjs>`), which `ServerJSPayloadListener.process` *consumes the
instant it parses* — by the time a content-script observer runs, the blob is
gone. Ordinary SSR data blobs (`dataLayer`, Redux state, JSON-LD) are **not**
self-consumed and remain readable at DOMContentLoaded, which is why the passive
scrape works on them. Meta sites have dedicated parsers anyway.

### Manifest vs progressive — declared, never URL-sniffed

`DownloadTask.selectStrategy` routes from the entity: separate `audioUrl` →
`FFmpegMergeStrategy`; `UrlType.MEDIA`/`TS` (`usesFFmpeg()`) → `FFmpegMuxStrategy`
(HLS/DASH); else → `HttpDownloadStrategy` (raw). The MEDIA-vs-FILE decision for
skip-probe variants must **not** be guessed from the URL extension — obfuscated/
tokenized manifests carry no `.m3u8`/`.mpd`, and signed URLs append a `#fragment`
(Dailymotion: `…/manifest.m3u8#cell=cf3`). Two layers, defense in depth:

- **Declared (source of truth).** The code that enumerated the master marks it:
  `M3U8Parser`/`processHlsMaster` → `VariantProcessor(…, manifest=true)`, and the
  JS `parseHlsMaster` path sets `manifest:true` on the `sendVariants` message
  (→ `JsonHelper` → `GeckoInspectEntity` → `GeckoInspectTask` → `VariantProcessor`).
  `VariantProcessor` sets MEDIA on declared-manifest **or** separate-audio; the
  URL regex (`MANIFEST_URL`, `[?#]`-tolerant) is only a fallback. Progressive is
  the default so a tokenized extensionless mp4 (TikTok) isn't needlessly remuxed.
- **Content backstop (ground truth).** `HttpDownloadStrategy` peeks the response
  before writing — `#EXTM3U` (HLS), an `<MPD>` XML (DASH), or a manifest
  Content-Type → hand off to `FFmpegMuxStrategy` instead of saving the playlist
  text as the file. Catches anything misclassified onto the raw path, **esp. the
  generic catcher's obfuscated manifests** (no parser to declare them). `stop()`
  forwards to the delegate; checked only on a fresh (non-resume) request.

Don't reintroduce extension-only manifest detection as the load-bearing test —
it's a fallback at best. (`UrlStringUtils`' SVG/ICO/ADAPTATIVE patterns were also
`?`-only and missed `#fragment`s; now `[?#]`.)

### Progress reporting (`downloader_mux`)

Mode is decided once for the whole download: **TIME** (muxed position vs.
duration — the normal path, incl. HLS/DASH VOD), **SIZE** (bytes vs.
Content-Length, progressive only), or **NONE** (indeterminate). For TIME the
reported position is the **minimum** of the per-stream accumulators: with split
audio+video the two advance at different rates, so reporting the current
packet's stream made the bar jump backward — the min is monotonic and is the
position every track has reached. SIZE is never used for HLS/DASH because their
probe `Content-Length` is the *playlist* size, not the media.

### Per-site request quirks live in the parser, never the transport

`FFmpegOkhttp` / the fork's `http.c` (the ffmpeg↔OkHttp bridge) is **generic**
and must carry **no host-specific conditions**. Any header a site needs is
expressed as *data* in that site's parser `requestHeaders` (the `sendNative`
emit). ffmpeg then propagates those headers to **every** sub-request of the
download — master, media playlist, segment, **and the AES key** (hls.c fetches
the key via `open_url(..., &c->avio_opts, ...)`, and `avio_opts` is copied from
the master's options). So a header a site needs *only* on its key fetch still
belongs in the parser emit, not in a transport `if (url.contains(host))`.

The bridge also never needs host logic to keep a key fetch clean: it only adds a
`Range` for a resume (`pos>0`) or when chunking a confirmed-large file (>2 MB),
so a 16-byte, offset-0 AES key is never ranged for **any** site.

#### Niconico domand AES key — the "endless probing / 720p hangs" bug
**Root cause: the domand AES key is SINGLE-USE per session.** The key endpoint
(`…/keys/<rendition>.key`, per-session signed URL) returns the real 16-byte key
only on the **first** fetch; every later fetch of the *same URL* returns a
different **garbage decoy** (HTTP 200, no error). Firedown opens the stream
**twice** per session — `metadatareader` probes it (burns the real key), then
`downloader` opens it again and gets a decoy. Wrong key → AES-CBC garbage (no
integrity check) → the `mov` demuxer reads a phantom multi-hundred-MB box and
`avio_skip`s it across the whole track → `find_stream_info` walks every segment
to EOF → the hang. It scales with rendition size, so tiny renditions tolerate
it while 480p/720p hang. Within one `avformat_open_input` the key is fetched
once and cached by URL, so the duplication is across the two separate opens.

**Fix (SHIPPED, in the fork — not an app-flow tweak):** a process-global AES-key
cache in `libavformat/hls.c` `read_key`, keyed by the **full signed key URL**,
first-writer-wins, FIFO-16, `AVMutex`-guarded — the probe's real key is reused
by the downloader instead of fetching a decoy. See `firedown-ffmpeg/CLAUDE.md`
and `firedown/patches/0004-hls-c-single-use-key-cache.patch` (generator +
`apply-firedown-patches.sh`, marker `FIREDOWN-HLS-KEYCACHE`); needs a `.so`
rebuild + `scripts/sync-ffmpeg.sh`. Confirmed on device.

**Keep it unconditional** — do not gate behind an AVOption. `metadatareader`
(open #1) is always the first key consumer, so it always gets the real key and
the item always shows in Capture *regardless of any option*; only `downloader`
(open #2) needs the cache. A gated cache not set on both opens gives the worst
UX — "shows in Capture, then hangs on download". It's URL-keyed (no cross-content
collision) and for a normal VOD the cached bytes equal a re-fetch, so reuse is
transparent. (If a site ever misbehaves, prefer opt-**out** over opt-in.)

**Rotating keys:** a new key URL per `#EXT-X-KEY` is fully handled (each URL is
its own entry). Same-URL/changing-bytes rotation is NOT (that's live HLS;
Firedown downloads VOD) — recovery there is app-level (re-run the parser to mint
a fresh session), not in hls.c. *Refresh-on-garbage* is DEFERRED: a blind
re-fetch returns a decoy and hls.c can't re-mint a session; it would need a
mov→hls feedback channel that doesn't exist yet.

**Diagnostic discipline (this bug ate ~10 rounds on confounds):**
- A clean test = a FRESH session where ffmpeg is the FIRST thing to touch the
  key. Any run that is the 2nd+ consumer gets a decoy and walks — it looks
  identical to the bug but proves nothing. (Most throwaway scripts self-poisoned
  by fetching/decrypting the key before ffmpeg ran.)
- Confounds tested and DISPROVEN — do **not** revisit: `X-Frontend-Id`, cookies,
  `Range`, seekability/`is_streamed`. (The `http.c` `is_streamed = (total<=0)`
  fix is a *separate* read_header-walk bug; it does not affect this
  find_stream_info key-walk.)
- The walk is ffmpeg's reaction to an undecryptable stream, not a demuxer bug:
  `probesize`/`analyzeduration` don't bound it (garbage produces no packets).
  Stock `ffmpeg -i <master>` on a PC reproduces it (no `X-Frontend-Id`) — same
  wrong-key cause, not a transport bug.

## Security toggles & default inversion (the JIT/WASM pattern)

Several "harden the browser at a cost" switches in the Security settings
category are **disable-X** toggles that default **OFF** (the feature is on by
default; turning the switch on hardens at a performance/compat cost):
`SETTINGS_DISABLE_WASM`, `SETTINGS_DISABLE_WEBGL`, `SETTINGS_DISABLE_JIT`.

JavaScript JIT is the canonical case. JIT widens the attack surface, so a
"disable JIT" control belongs in the advanced/Security section — but disabling
it globally noticeably degrades complex sites, so it must be **enabled by
default** (most users should never touch it; only the security-conscious turn it
off). `setJITCompiler(!disable)` is read at boot in `GeckoRuntimeHelper`
(inverted) and on change in `SettingsFragment`; it sets
`javascript.options.baselinejit` + `…wasm_baselinejit`; changing it restarts the
browser.

**When flipping an enable→disable default, always introduce a NEW preference
key** (`…enable.jit` → `…disable.jit`). The stored boolean can't be reused: an
old user who never touched the opt-in `enable` pref has `false` saved, which
under the new default-enabled semantics would read back as "JIT off" and silently
keep them on the old baseline. A fresh key lets existing installs fall to the new
default. (Same reasoning as the `SETTINGS_DISABLE_WASM` migration.) Rename the
string resources to match (`settings_jit_enabled*` → `settings_jit_disabled*`)
and update **all** locale files, not just English.

### UTC timezone spoofing toggle (FPP target, not a code patch)

`SETTINGS_SPOOF_TIMEZONE` is an **enable-style opt-in** (default OFF, like Resist
Fingerprinting — UTC clocks confuse calendar/scheduling sites). It does **not**
need a GeckoView patch: FPP is already enabled at boot
(`setFingerprintingProtection(true)`), so `JSDateTimeUTC` is a stock target.
`GeckoRuntimeHelper.setTimezoneSpoofing` just flips it via the **global**
`privacy.fingerprintingProtection.overrides` pref (`"+JSDateTimeUTC"` on, `""`
off) — read at boot and on change in `SettingsFragment` (no restart; applies on
next page load, like RFP). **Crucially, that GLOBAL `overrides` pref is distinct
from the per-site `granularOverrides`** pref. The latter is no longer set by
anything (it used to scope CanvasRandomization to tiktok.com via the now-removed
`applyTikTokFingerprintingOverride`); keep these two prefs distinct — if a
per-site override is ever reintroduced, it must not fold into this global
`overrides` pref. This is deliberately the no-patch route over IronFox's
`nsRFPService` code patch + custom bool pref (firedown-geckoview CLAUDE.md has the
rationale). New string keys (`settings_utc_timezone*`) are translated across the
same 16 locales the JIT toggle uses; the remaining (already-partial) locales fall
back to English (MissingTranslation isn't build-fatal here).

## UI conventions (Material 3)

- **Menu rows are M3 one-line list items: 56dp tall, 16sp text
  (`TitleMedium`), 16dp horizontal gutter, `onSurfaceVariant`.** Applies to
  every menu/sheet surface — Browser/Home popups (hand-built `LinearLayout`
  rows), the Security sheet + its blocked-ads/trackers detail dialogs and
  variant rows, the `OptionsAdapter` sheets (New tab / Web options / Downloads
  option, via the `Firedown.Widget.DialogOption` style → `minHeight=56dp` so a
  rare wrapped label can grow), and the search-engine list. The 16dp gutter is
  shared too — identity headers and sheet content insets all sit at 16dp (not
  the old 20/24dp). Two-line rows (e.g. Download info) stay at 72dp. Keep these
  in lockstep; don't reintroduce a denser 48dp, a 15sp override, or a 20/24dp
  gutter for one sheet.
- **The generated mime fallback thumbnail (`MimeTypeThumbnail`) has two modes.**
  List/grid rows pass `fillBounds=true` so the tint fills the whole
  rounded-clipped slot (the list slot is ~1:1, 78×64dp). The **media viewer
  keeps the default 16:10 letterbox** (`fillBounds=false`) to match
  `PlayerView`'s `resize_mode="fit"` — don't make the fill unconditional, it
  would paint the player background edge-to-edge.
- **List-row meta line is `MIME · domain` — plain text, no domain icon.** Both
  list rows that show captured/downloaded media (`fragment_download_item.xml`
  and `fragment_browser_options_item_list.xml`, `row_meta` →
  `mime_text` + `file_url`) read `VÍDEO · youtube.com`. The mime label
  (`MimePrimaryLabel`, adapter appends a trailing `" · "`) doubles as the
  separator, so `file_url` follows directly with no leading margin. There is
  deliberately **no globe/favicon `ImageView`** between them — it was removed as
  decoration (identical on every row, redundant with both the domain text and
  the `·`). Don't reintroduce a domain icon here; if you ever do want a
  per-site favicon, that's a different, data-bound feature, not the old static
  globe. The third line (`size · date · duration/resolution/language`) is the
  informative density and stays. The two layouts and the grid tile are kept in
  lockstep — change the meta line in both list rows together.
- **Grid tile title: hidden for self-identifying image tiles in BOTH Downloads
  and Captured.** The rule is *not* "images are clutter" — it's
  "drop the title only for the one type whose thumbnail fully identifies it."
  Both `DownloadItemAdapter` and `BrowserOptionAdapter` (Captured) hide
  `file_name` in the grid **iff** `isGrid && FileUriHelper.isImage(mimeType)`
  (covers GIF/SVG) — image thumbnails *are* the content and their names are
  almost always junk slugs, so the title is ink over the picture. Everything
  else keeps it: **audio is the load-bearing case** (no real thumbnail — hiding
  the title leaves an unidentifiable mime tile), and video/subtitle/doc
  thumbnails are too weak (black frames, generic glyphs) to discriminate without
  the name. The list always shows the title (both adapters). Keep this keyed on
  the **mime** (`isImage`), not on a filename-content heuristic: the old
  "name has no spaces ⇒ junk" test was removed because it misclassifies
  space-less scripts (CJK/Thai) and silently drops real titles. The mime chip is
  always present in both grids, so type stays labelled even when the title is
  hidden. (Captured used to *always* show the title as a pre-download decision
  surface; that was changed to match Downloads — an image tile's slug name is
  noise on the decision surface too.)

## Thumbnails (native `thumbnailer.c`)

`FFmpegThumbnailer.getBitmap(streamPos)` reads one frame; `streamPos` is a
three-way contract: **`>0`** seeks to that mid-clip position (explicit mandate,
`AVSEEK_FLAG_ANY`); **`==0`** decodes the head frame (some callers need the
first frame exactly — GifMaker tiles it across the filmstrip, SaveFrame
fallback); **`<0`** means *no mandate*, so the native side auto-seeks
`THUMBNAIL_DEFAULT_OFFSET_US` (3s) in (`BACKWARD` to the enclosing keyframe) to
skip the usual black opening frame — applied only when the clip is longer than
the offset (a shorter clip decodes the head, frame 0 being fine there), and
falling back to the head on seek/decode failure.
The Glide decoders default a missing `GlideRequestOptions.LENGTH` to `-1`
(auto); an explicit `LENGTH` (Media/Image viewers pass the file size) is passed
through. **Don't extend the auto offset to `0`** — that breaks the head-frame
callers. For finished downloads the frame comes from Glide's built-in
MediaMetadataRetriever (the `DownloadEntity→ParcelFileDescriptor` path wins over
`FFmpegUriDecoder`); `GlideHelper` requests a small ~2s offset
(`effectiveThumbnailFrame`) with `VideoDecoder.FRAME_OPTION =
OPTION_NEXT_SYNC` — the first keyframe at/after the offset. The default
`OPTION_CLOSEST_SYNC` can snap back to the black t=0 keyframe on a sparse GOP;
`OPTION_CLOSEST` would decode the exact frame but walks the whole GOP (too heavy
for a scrolling list). NEXT_SYNC is a single-keyframe decode always past the
intro. Keep the offset **small** — NEXT_SYNC only needs to clear the opening,
and a large offset would clamp the many short clips this app captures to the
head frame.

## Conventions

- Match the surrounding comment density — the parsers are heavily commented
  with *why*, including dead-ends not to retry. Keep that.
- Don't push to `main`; develop on a feature branch and open a PR only when
  asked.
- **One working branch per session — do NOT cut a new branch for every
  request.** Keep committing follow-up work to the branch already in play; only
  branch when starting genuinely unrelated work or when the user asks. If you
  did split something off, merge it back into the working branch rather than
  leaving a trail of one-commit branches.
- Commit messages: explain the root cause and how it was verified, not just the
  change.
- **C style (all native sources under `app/src/main/cpp/`): write standard,
  explicit, readable C.** This is a general rule for every `.c`/`.h` here, not
  about any one line. In particular:
  - One operation per statement: no assignments inside `if`/`while` conditions,
    no multiple side effects per line.
  - Don't chain an interrupt/error check, an assignment, and control flow
    (`goto`/`return`) together on a single line.
  - Always brace blocks; put the body on its own line(s).
  - Check return values explicitly: assign to a variable, then test it.
  - **Declare a function's working variables in the declaration block at the
    top of the function** (as the existing sources do — see `downloader_mux`),
    not interleaved with statements mid-function. A `for (int i = …)` counter
    or a temporary at the **start of a nested block** is fine; a fresh
    declaration after executable statements in the function body is not. If a
    block needs several locals, that's a sign it should be its own helper
    (e.g. `downloader_log_progress`).

  Parts of the existing code use a terser, condition-with-side-effects form
  (e.g. `if (x->interrupt || (err = f()) < 0) goto error;`). That is **not** the
  style to follow — do not propagate it. Write the explicit equivalent
  (`if (x->interrupt) goto error;` then `err = f(); if (err < 0) goto error;`)
  for anything you add or modify.
