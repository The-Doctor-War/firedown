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

## Conventions

- Match the surrounding comment density — the parsers are heavily commented
  with *why*, including dead-ends not to retry. Keep that.
- Don't push to `main`; develop on a feature branch and open a PR only when
  asked.
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

  Parts of the existing code use a terser, condition-with-side-effects form
  (e.g. `if (x->interrupt || (err = f()) < 0) goto error;`). That is **not** the
  style to follow — do not propagate it. Write the explicit equivalent
  (`if (x->interrupt) goto error;` then `err = f(); if (err < 0) goto error;`)
  for anything you add or modify.
