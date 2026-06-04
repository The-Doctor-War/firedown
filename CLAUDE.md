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
`window.__initialState` (a devalue IIFE) and fires no playurl XHR, so a
page-world inject (`bilibili-tv-inject.js`, loaded as a moz-extension WAR to
bypass CSP — the TikTok pattern) reads `player.playUrl.dash.{video,audio}` and
emits the two whole-track `.m4s` baseUrls (DASH SegmentBase — each baseUrl is
one complete track byte-range-fetched, *not* a segment list) as video+audio
variants, which `FFmpegMergeStrategy` muxes natively (no ffmpeg.wasm).
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

## WebExtension loading & versioning (GeckoView gotcha)

`registerBuiltIn` → `WebExtensionController.ensureBuiltIn(uri, id)` caches the
extension **keyed by the manifest `version`**. If you change a manifest
(e.g. add a `content_scripts` entry) but **don't bump
`parser/manifest.json`'s `version`**, an in-place app update
(`adb install -r`) keeps the old registration and your change silently doesn't
load. To force a re-register: **bump the version**, or do a clean
**uninstall + install** (which wipes the registration so any version reloads).
Symptom of this trap: a brand-new listener/content-script produces *no logs at
all*.

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

## Downloading & networking

Two download paths, one shared OkHttp client (`NetworkModule`, with
`OriginInterceptor` — it derives **Origin from an existing Referer**, it does
not invent a Referer; Referer must come from the capture/emit layer).

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
**ROOT CAUSE (confirmed): the domand AES key is SINGLE-USE per session.** The
key endpoint (`…/keys/<rendition>.key`, `Cache-Control: private, no-cache`)
returns the real 16-byte key **only on the first fetch** after an
`access-rights/hls` session is minted; every later fetch returns a *different
garbage decoy* (verified: fetch the same key URL 3× in one session → #1 decrypts
to `styp+moof+mdat`, #2/#3 are garbage and differ). The key is
fetched **twice** — `metadatareader` probes the stream first (consumes the real
key), then the `downloader` opens it again and gets a decoy → garbage decryption
→ the `mov` demuxer finds no `moof`/`mdat` → `find_stream_info` walks every
`.cmfa` to EOF. That is the hang.

Note the boundary (from hls.c): within a **single** `avformat_open_input`,
`open_input`→`read_key` fetches the key **once** and caches it by URL
(`strcmp(seg->key, pls->key_url)`), and a media playlist carries **one**
`#EXT-X-KEY` for all segments. So the duplication is **across the two separate
libavformat opens** (probe context + download context), each a fresh sign-in
that re-fetches and burns another single-use key.

**Caveat — it can ALSO double-fetch within ONE open.** `A_naive.log` (stock
ffmpeg, a single invocation) fetched `video-h264-720p.key` *twice*: the second
right after `update_init_section` re-opened the init segment (`hls_read_seek`
sets `pls->cur_init_section = NULL`, so a probe that walks re-reads the init
and re-runs the key gate). But that only fires once the decode is *already*
walking on a bad key — i.e. it's a **symptom** of an already-spent session
(in `A_naive` both tracks decrypted to garbage on their *first* fetch, so it
was a 2nd-consumer run), not the trigger. The URL-keyed cache covers it anyway
(the init re-open hits the cache). So "one fetch per context" holds only on the
*happy* path; don't rely on it.

**Fix must be in ffmpeg (the fork), not an app-flow tweak** — a plain
`ffmpeg`/libavformat user hits the same single-use key whenever it opens the
stream more than once (probe + read). Strategy: **cache the key and reuse it;
refresh only on garbage.**
1. *Cache + reuse* — patch the fork's `libavformat/hls.c` `read_key` with a
   process-global AES-key cache: on the first successful fetch store the 16
   bytes; on every later `read_key` copy the cached bytes into `pls->key` and
   skip the server round-trip. This stops the second/third open from burning a
   decoy. Belongs with the fork hls.c patch set (`firedown/patches`); needs a
   `.so` rebuild + `scripts/sync-ffmpeg.sh`.
2. *Refresh on garbage* — if the cached key produced an undecodable stream
   (the mov walk / no valid `moof`), invalidate the entry and re-fetch.
   **Caveats (why this is DEFERRED, see below):** hls.c **cannot re-mint** an
   `access-rights/hls` session — minting is an app-level re-capture (nvapi +
   cookies + `accessRightKey`), invisible to the demuxer; and a *blind*
   re-fetch returns a **decoy** for a single-use key, so it would re-break
   niconico. Any refresh must be guarded (e.g. armed only after a successful
   decode for that URL, or off for the domand host) and needs a mov→hls
   feedback channel that doesn't exist yet.

RESOLVED (the two questions that gated the cache design). Neither could be
settled with a *fresh live test* — there's no logged-in nico session or
on-device build reachable from where this work was done, and (decisively) any
live probe that fetches the key first burns fetch #1 and poisons the run, which
the work was forbidden to do. So both were settled by reasoning from the
recorded evidence + upstream `hls.c`, and — more importantly — the cache was
**keyed so the answer doesn't gate correctness**:
- **Static per content vs. per-session → treat as per-session.** Two dumps of
  the same content yielded different working keys (`c93a35…` vs. `0d7c50…`),
  and the endpoint is `Cache-Control: private, no-cache` behind a per-session
  signed URL. So the cache is **keyed by the full signed key URL** (which
  embeds the session token), never by bare path/rendition. That keying is
  correct under *either* answer: same session ⇒ same URL ⇒ one real fetch
  reused across probe+reader; new session ⇒ new URL ⇒ its own fetch #1. We
  never serve one session's bytes to another, so even if the key were static
  per content this is still right (just one fetch per session).
- **Does a single clean first-consumer open converge? → Yes, by
  construction.** Within one `avformat_open_input`, `open_input` fetches the
  key exactly once (`strcmp(seg->key, pls->key_url)`) and a media playlist
  carries one `#EXT-X-KEY`; a clean first open therefore burns only fetch #1
  (the real key) and decodes. The bug is *exclusively* the second open. The
  cache collapses probe+reader back to that single real fetch, so it is the
  full fix for the duplicate-fetch case.

SHIPPED: the *cache + reuse* patch (item 1) — `firedown-ffmpeg` `master` (and
`dev/animated-webp`), `firedown/patches/0004-hls-c-single-use-key-cache.patch`
(generator: `firedown/scripts/generate-keycache-patch.sh`; wired into
`apply-firedown-patches.sh`, gated on a `FIREDOWN-HLS-KEYCACHE` marker). The
cache is keyed by the full signed key URL, FIFO-bounded (16 entries),
first-writer-wins (a racing decoy fetch can't clobber a cached real key), and
guarded by a static `AVMutex`. Confirmed on device: a nico 720p stream that
previously hung now downloads and muxes (the probe burns the real key, the
reader reuses it instead of fetching a decoy). A `.so` rebuild +
`scripts/sync-ffmpeg.sh` is still needed to ship the rebuilt binaries.
KEEP IT UNCONDITIONAL — do **not** gate the cache behind a parser/AVOption.
We considered an opt-in `firedown_key_reuse` bool (set per-site from the parser
`sendNative`). **Rejected** because of an asymmetric failure mode: the two
opens are not symmetric toward the key. `metadatareader` (open #1) is **always
the first consumer**, so it **always gets the real key and always succeeds** —
the item **always shows in the Capture fragment**, regardless of any option.
Only `downloader` (open #2) depends on the cache. A gated cache must therefore
be set on *both* opens (metadatareader to *populate*, downloader to *use*); if
the parser/app fails to set it on either, you get the worst UX — **"shows in
Capture, then hangs on download"** — with no warning, because metadatareader
never needed the option. Forcing the cache on removes that whole class of bug,
and it's safe: it's keyed by the full key URL (no cross-content collision), and
for a *normal* stream the cached bytes equal what a re-fetch would return, so
reuse is transparent. The only case where reuse differs is a **stable-URL,
rotating-key** stream — which is *live* HLS; Firedown downloads VOD. So the
theoretical conflict is far less likely than the gating trap, and is outweighed.
(If a misbehaving site ever appears, prefer an **opt-OUT** — default on,
`=0` to disable per-site — over opt-in, so the default never strands a
download.)

ROTATING KEYS — what the cache does and doesn't handle:
- **Standard rotation (a new key URL per `#EXT-X-KEY`)**: fully handled — each
  URL is its own cache entry / its own fetch, exactly like stock ffmpeg.
- **Same-URL rotation (stable URL, bytes change over time)**: NOT handled — the
  cache serves the stale bytes until process exit / FIFO eviction. No
  invalidation, no re-fetch, no re-mint. This is the DEFERRED item below. The
  correct recovery is **app-level** (detect the failed download, re-run the
  parser to mint a fresh session, retry with the new URLs), not anything inside
  hls.c.

DEFERRED: *refresh on garbage* (item 2) — not needed for the duplicate-fetch
hang and it requires undecodable-stream feedback from the mov layer; and a
naive version would re-break niconico (re-fetch = decoy). Revisit only if a
real stable-URL-rotating-key site appears, and make it guarded (see item 2).

DIAGNOSTIC DISCIPLINE (this bug ate ~10 rounds on confounds — don't repeat):
- **A clean test = a FRESH session where ffmpeg is the FIRST thing to touch the
  key.** Any run that is the 2nd+ consumer of a key URL gets a decoy and walks —
  which looks identical to "the bug" but proves nothing.
- **Known traps in the throwaway scripts** (kept only as cautionary history):
  `nico_probe.py` step [3] GETs+decrypts the key *before* running ffmpeg →
  ffmpeg is the 2nd consumer → always walks (self-poison). `nico_keyhdr.py`
  fetches the key 5× in one session → only fetch #1 (variant A) is real →
  *falsely* implicated `X-Frontend-Id` (the disproven theory). Reusing a dumped
  `resolved.json` whose session was already touched, or `A_naive.log`'s spent
  session, → both tracks garbage on the *first* fetch → always walks.
  `nico_keyonce.py` is the one clean proof of single-use (same URL ×3 → #1 real,
  #2/#3 garbage+different); it does **not** involve ffmpeg.
- **Confounds already tested and discarded — do NOT revisit:** headers
  (`X-Frontend-Id`), cookies, `Range`, and seekability/`is_streamed`. The
  `http.c` `is_streamed = (total <= 0)` fix is a **separate** bug (it stops the
  *read_header* moof/mdat walk for a seekable-unknown-size stream); it makes
  **no** difference to this key-walk, which happens in `find_stream_info` on a
  decoy key.

DISPROVEN earlier theory (do not repeat): "the key needs `X-Frontend-Id: 6` and
no `Range`." That was a **confound** — in the header experiment, the only
variant that worked was simply the *first* key fetch; the header was irrelevant.
Any test that fetches/decrypts the key before the real consumer will poison the
run (the consumer then gets a decoy). The earlier observations below are kept
only as the symptom description:

`delivery.domand`'s key endpoint returns a **wrong 16-byte key** (HTTP 200, not
403) on any fetch after the first.
A wrong key → every fMP4 segment decrypts to garbage. Nothing errors: AES-CBC
has no integrity check (wrong key = silent garbage), and `mov` reads the garbage
as an MP4 box header with a bogus, usually multi-hundred-MB size and an unknown
type, which it **skips** (`avio_skip`) — skipping unknown boxes is normal, not
an error. Because the HLS demuxer presents all segments as one continuous
stream, that single phantom box is skipped across **the whole track to EOF**
(we observed `type:'…' sz: 1030796069`). So it's a silent multi-minute read,
not a failure — fast enough to tolerate on tiny renditions, a hang on 480p/720p
(the phantom size exceeds every rendition, so the walk length ≈ total track
bytes, which is why it scales with quality). A "could not find codec parameters"
only surfaces much later, after it's read everything. Fix: `background.js` `emitNicoStream` sends
`X-Frontend-Id`/`X-Frontend-Version`; OkHttp already fetches the key from
offset 0 so it sends no `Range`. Verified by replaying the live key URL under
header permutations and decrypting segment 1 with each returned key — only
`X-Frontend-Id` **and** no-`Range` yields valid `styp/moof/mdat`.

Don'ts (each cost rounds here):
- The walk is ffmpeg's *reaction* to an undecryptable stream, **not** a demuxer
  bug. `probesize`/`analyzeduration` do **not** bound it — `read_size` only
  grows on packets the demuxer actually produces, and garbage produces none, so
  the probe runs to EOF regardless. Don't chase seekability/`is_streamed` for
  this; chase the key.
- Stock `ffmpeg -i <master>` on a PC reproduces the same walk because native
  `http.c` sends `Range`+`Icy-MetaData` and no `X-Frontend-Id` → also a wrong
  key. That it reproduces off-device does **not** make it a transport/demuxer
  bug — it's the same wrong-key cause.
- The key endpoint hands back a *different* wrong key per request when the
  binding/headers are off, and a key fetched out of a stale/partial
  `access-rights/hls` session is garbage too — don't mistake either for a
  rotating-DRM or scope problem; the live web flow (`X-Frontend-Id`, full
  `outputs`, no `Range`) returns the one real key.

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

## Thumbnails (native `thumbnailer.c`)

`FFmpegThumbnailer.getBitmap(streamPos)` reads one frame; `streamPos` is a
three-way contract: **`>0`** seeks to that mid-clip position (explicit mandate,
`AVSEEK_FLAG_ANY`); **`==0`** decodes the head frame (some callers need the
first frame exactly — GifMaker tiles it across the filmstrip, SaveFrame
fallback); **`<0`** means *no mandate*, so the native side auto-seeks
`THUMBNAIL_DEFAULT_OFFSET_US` (3s) in (`BACKWARD` to the enclosing keyframe) to
skip the usual black opening frame — clamped to the clip midpoint, skipped for
stills/sub-second clips, and falling back to the head on seek/decode failure.
The Glide decoders default a missing `GlideRequestOptions.LENGTH` to `-1`
(auto); an explicit `LENGTH` (Media/Image viewers pass the file size) is passed
through. **Don't extend the auto offset to `0`** — that breaks the head-frame
callers.

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
