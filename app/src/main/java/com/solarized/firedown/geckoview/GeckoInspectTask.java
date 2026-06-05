package com.solarized.firedown.geckoview;

import android.text.TextUtils;
import android.util.Log;

import com.caverock.androidsvg.SVG;
import com.solarized.firedown.data.entity.BrowserDownloadEntity;
import com.solarized.firedown.data.entity.FFmpegTagEntity;
import com.solarized.firedown.data.entity.GeckoInspectEntity;
import com.solarized.firedown.data.repository.BrowserDownloadRepository;
import com.solarized.firedown.ffmpegutils.FFmpegEntity;
import com.solarized.firedown.ffmpegutils.FFmpegMetaData;
import com.solarized.firedown.ffmpegutils.FFmpegMetaDataReader;
import com.solarized.firedown.manager.UrlType;
import com.solarized.firedown.utils.BrowserHeaders;
import com.solarized.firedown.utils.FileUriHelper;
import com.solarized.firedown.utils.JsonHelper;
import com.solarized.firedown.utils.M3U8Parser;
import com.solarized.firedown.utils.UrlStringUtils;
import com.solarized.firedown.utils.WebUtils;

import org.json.JSONArray;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Processes intercepted media URLs from WebExtensions.
 * Handles three paths:
 * - Variants (Twitter, Instagram, YouTube adaptive): pre-parsed streams, probed individually
 * - FFmpeg (HLS, DASH, direct media): single URL probed by FFmpegMetaDataReader
 * - Special types (SVG, timed text): custom handling
 */
public class GeckoInspectTask implements Runnable {

    private static final String TAG = GeckoInspectTask.class.getSimpleName();

    private static final Set<String> BLOCKED_HEADERS = Set.of(
            BrowserHeaders.HOST, BrowserHeaders.CONNECTION,
            BrowserHeaders.ACCEPT_ENCODING, BrowserHeaders.ACCEPT,
            // The intercepted request from a <video> element is typically a
            // partial-range chunk request from the player (e.g.
            // bytes=4068494-4358829). If we forwarded that into a download
            // we'd only get the slice the player was streaming, hit EOF at
            // the slice boundary, and report success. Strip it here so
            // every downstream consumer (HTTP/Gecko strategies, FFmpeg
            // probes) starts from a clean header set.
            BrowserHeaders.RANGES
    );

    // Hop-by-hop / context-bound headers we always strip, regardless of
    // origin. Range is in here for the reason above; the rest would either
    // confuse okhttp (Host is set per URL) or break the connection (a stale
    // Connection: keep-alive value from an intercepted request).
    private static final Set<String> ALWAYS_BLOCKED_HEADERS = Set.of(
            BrowserHeaders.HOST, BrowserHeaders.CONNECTION, BrowserHeaders.RANGES
    );

    private final BrowserDownloadRepository mBrowserDownloadRepository;
    private final UrlType mUrlType;
    private final String mUrl;
    private final String mOrigin;
    private final String mDescription;
    private final String mName;
    private final String mImg;
    private final String mRequestId;
    private final int mTabId;
    private final int mVisitId;
    private final Map<String, String> mRequestHeaders;
    private final ArrayList<FFmpegEntity> mVariants;
    private final String mSabrUrl;
    private final String mSabrConfig;
    private final String mSabrClientVersion;
    private final String mSabrPoToken;
    private final String mSabrVideoId;
    private final String mSabrVisitorData;
    private final long mDuration;
    private final String mLanguage;
    private final boolean mIncognito;
    private final boolean mSkipProbe;
    // Parser-declared: the variants are HLS/DASH manifests (ffmpeg must mux).
    private final boolean mManifest;
    private FFmpegMetaDataReader mFFmpegMetaDataReader;

    public GeckoInspectTask(
            BrowserDownloadRepository repository,
            UrlType type,
            GeckoInspectEntity geckoInspectEntity) {

        mBrowserDownloadRepository = repository;
        mUrlType = type;
        mUrl = WebUtils.deParameterize(geckoInspectEntity.getUrl());
        mOrigin = geckoInspectEntity.getOrigin();
        mDescription = geckoInspectEntity.getDescription();
        mRequestId = geckoInspectEntity.getRequestId();
        mRequestHeaders = safeHeaders(geckoInspectEntity.getRequestHeaders());
        mTabId = geckoInspectEntity.getTabId();
        mVisitId = geckoInspectEntity.getVisitId();
        mName = geckoInspectEntity.getName();
        mImg = geckoInspectEntity.getImg();
        mVariants = geckoInspectEntity.getVariants();
        mSabrUrl = geckoInspectEntity.getSabrUrl();
        mSabrConfig = geckoInspectEntity.getSabrConfig();
        mSabrClientVersion = geckoInspectEntity.getSabrClientVersion();
        mSabrPoToken = geckoInspectEntity.getSabrPoToken();
        mSabrVideoId = geckoInspectEntity.getSabrVideoId();
        mSabrVisitorData = geckoInspectEntity.getSabrVisitorData();
        mDuration = geckoInspectEntity.getDuration();
        mLanguage = geckoInspectEntity.getLanguage();
        mIncognito = geckoInspectEntity.isIncognito();
        mSkipProbe = geckoInspectEntity.isSkipProbe();
        mManifest = geckoInspectEntity.isManifest();

        Log.d(TAG, "Task Created for URL: " + mUrl + " img: " + mImg
                + " variants: " + (mVariants != null ? mVariants.size() : 0)
                + " sabr: " + (mSabrUrl != null));
    }

    @Override
    public void run() {
        if (!UrlStringUtils.isURLLike(mUrl)) {
            Log.w(TAG, "Aborting: Incorrect URL format: " + mUrl);
            return;
        }

        BrowserDownloadEntity entity = prepareEntity();

        if (mBrowserDownloadRepository.contains(entity)) {
            Log.w(TAG, "URL already intercepted, skipping: " + mUrl);
            return;
        }

        try {
            boolean processed = processTask(entity);
            if (processed) {
                applyDisplayName(entity);
                mBrowserDownloadRepository.addValue(entity);
            }
        } catch (Exception e) {
            Log.e(TAG, "Processing failed for: " + mUrl, e);
        } finally {
            cleanupFFmpeg();
        }
    }

    // ========================================================================
    // Entity preparation
    // ========================================================================

    private BrowserDownloadEntity prepareEntity() {
        BrowserDownloadEntity entity = new BrowserDownloadEntity();
        String mimeType = FileUriHelper.getMimeTypeFromFile(mUrl);

        // De-dup identity. Normally the media URL is the stable identity of a
        // capture, so uid = url.hashCode() and the repository collapses repeats.
        // But HLS-master sites (niconico / Twitch / Kick) mint a FRESH
        // session-signed master+rendition URL on every page load, so the same
        // video refreshed 3× yields 3 different URLs → 3 duplicate entries. For
        // these, the stable identity is the watch/channel page (the origin), so
        // key the uid on it: a refresh re-resolves to the same uid and the
        // contains()/addValue fast-path (uid match) drops it — before we even
        // re-fetch the master. (The 30s JS-side origin dedup only covers rapid
        // refreshes; this covers the rest and is per-tab via isPresent's tabId
        // guard.) Falls back to the URL when origin is missing.
        boolean originKeyed = mUrlType == UrlType.HLS_MASTER && !TextUtils.isEmpty(mOrigin);
        entity.setUid(originKeyed ? mOrigin.hashCode() : mUrl.hashCode());
        entity.setFileName(TextUtils.isEmpty(mName) ? WebUtils.getFileNameFromURL(mUrl) : mName);
        entity.setFileUrl(mUrl);
        entity.setFileOrigin(mOrigin);
        entity.setFileThumbnail(mImg);
        entity.setMimeType(mimeType);
        entity.setHeaders(mRequestHeaders);
        entity.setUpdateTime(System.currentTimeMillis());
        entity.setTabId(mTabId);
        entity.setVisitId(mVisitId);
        entity.setRequestId(mRequestId);
        entity.setFileDescription(mDescription);
        entity.setIncognito(mIncognito);

        // videoId + visitorData identify the video for PoToken minting and
        // are needed by BOTH the SABR stream path and the timedtext caption
        // path. They must be copied unconditionally — gating them behind the
        // sabrUrl/sabrConfig presence (as before) dropped them for timedtext
        // entities, which carry videoId/visitorData but no SABR stream URL.
        // Symptom was TimedTextStrategy logging
        // "mintPoToken: skipping (videoId=false visitorData=false)".
        if (!TextUtils.isEmpty(mSabrVideoId)) {
            entity.setSabrVideoId(mSabrVideoId);
        }
        if (!TextUtils.isEmpty(mSabrVisitorData)) {
            entity.setSabrVisitorData(mSabrVisitorData);
        }

        // SABR shared data (same for all variants of this video)
        if (!TextUtils.isEmpty(mSabrUrl) && !TextUtils.isEmpty(mSabrConfig)) {
            entity.setSabrUrl(mSabrUrl);
            entity.setSabrConfig(mSabrConfig);
            if (!TextUtils.isEmpty(mSabrClientVersion)) {
                entity.setSabrClientVersion(mSabrClientVersion);
            }
            if (!TextUtils.isEmpty(mSabrPoToken)) {
                entity.setSabrPoToken(mSabrPoToken);
            }
        }

        // Duration from innertube (for SABR-only variants where FFprobe can't run)
        if (mDuration > 0) {
            entity.setFileDuration(mDuration * 1000); // ms → µs to match FFprobe
        }

        return entity;
    }

    // ========================================================================
    // Task routing — each branch populates the entity, returns true if valid
    // ========================================================================

    /**
     * Routes to the correct processing strategy.
     * Returns true if the entity was successfully populated and should be committed.
     */
    private boolean processTask(BrowserDownloadEntity entity) throws Exception {
        if (mUrlType == UrlType.TIMEDTEXT) {
            entity.setMimeType(FileUriHelper.MIMETYPE_SRT);
            entity.setType(UrlType.TIMEDTEXT.getValue());
            appendLanguageTag(entity);
            return true;

        } else if (mUrlType == UrlType.SUBTITLE) {
            processSubtitle(entity);
            return true;

        } else if (mUrlType == UrlType.SVG) {
            processSvg(entity);
            return true;

        } else if (mUrlType == UrlType.HLS_MASTER) {
            return processHlsMaster(entity);

        } else if (mVariants != null && !mVariants.isEmpty()) {
            new VariantProcessor(mRequestHeaders, mSkipProbe, mManifest).process(entity, mVariants);
            return true;

        } else if (mSkipProbe && processMediaSkipProbe(entity)) {
            return true;

        } else {
            return processFFmpeg(entity, mUrl);
        }
    }

    // ========================================================================
    // FFmpeg probe — single URL (HLS, DASH, direct media)
    // ========================================================================

    private boolean processFFmpeg(BrowserDownloadEntity entity, String url) throws IOException {
        Log.d(TAG, "processFFmpeg: " + url);
        mFFmpegMetaDataReader = new FFmpegMetaDataReader();
        FFmpegMetaData metadata = mFFmpegMetaDataReader.getStreamInfo(url, mRequestHeaders, false);

        if (metadata == null || !metadata.isValidMedia()) {
            Log.w(TAG, "processFFmpeg error");
            return false;
        }

        parseMetadata(entity, metadata);
        return true;
    }

    /**
     * Single-URL media capture with skipProbe set (Apple Podcasts): the
     * metadatareader probe's only output we actually need was the duration, and
     * the parser already supplied it (formatted onto the entity in
     * prepareEntity). So classify from the URL-derived mime instead of opening
     * the file.
     *
     * <p>Audio only: returns {@code false} for anything we can't positively type
     * as audio from the URL (e.g. an extensionless tracking enclosure), so
     * {@link #processTask} falls through to the probe and never misclassifies.
     * type FILE keeps it on the raw {@code HttpDownloadStrategy} — the same
     * strategy the probe yields for a progressive audio file. Rebuilds the one
     * duration tag {@link #parseTags} would have added for the Capture view.</p>
     */
    private boolean processMediaSkipProbe(BrowserDownloadEntity entity) {
        String mime = entity.getMimeType();
        if (!FileUriHelper.isAudio(mime)) {
            return false;
        }
        entity.setType(UrlType.FILE.getValue());
        entity.setAudio(true);
        String duration = entity.getFileDuration();
        if (!TextUtils.isEmpty(duration)) {
            ArrayList<FFmpegTagEntity> tags = new ArrayList<>();
            tags.add(new FFmpegTagEntity(entity.getUid(), duration, FFmpegTagEntity.TYPE_DURATION));
            entity.setTags(tags);
        }
        return true;
    }

    private void parseMetadata(BrowserDownloadEntity entity, FFmpegMetaData metadata) {
        entity.setType(metadata.getType());
        ArrayList<FFmpegEntity> streams = mFFmpegMetaDataReader.getStreams();
        String mime = mFFmpegMetaDataReader.getMimeType(entity.getMimeType());

        entity.setAudio(metadata.isAudio());
        entity.setStreams(streams);
        entity.setHasVariants(streams.size() > 1);
        entity.setMimeType(mime);
        entity.setFileDuration(metadata.getDuration());
        entity.setPHash(metadata.getPHash());

        parseTags(entity, streams, mime);
    }

    // ========================================================================
    // Subtitle
    // ========================================================================

    private void processSubtitle(BrowserDownloadEntity entity) {
        String lower = mUrl.toLowerCase(Locale.US);
        String mime = lower.contains(".srt") ? FileUriHelper.MIMETYPE_SRT : FileUriHelper.MIMETYPE_VTT;
        entity.setMimeType(mime);
        entity.setType(UrlType.SUBTITLE.getValue());
        appendLanguageTag(entity);
    }

    private void appendLanguageTag(BrowserDownloadEntity entity) {
        if (TextUtils.isEmpty(mLanguage)) return;
        String existing = entity.getFileName();
        if (!TextUtils.isEmpty(existing)) {
            entity.setFileName(existing + " [" + mLanguage + "]");
        }
        // Also surface the language as a visible chip in the Capture fragment
        // (the filename suffix only shows once the row is expanded). Humanised,
        // e.g. "en" -> "English", "en-auto" -> "English (auto)".
        String display = localizeLanguage(mLanguage);
        if (TextUtils.isEmpty(display)) return;
        ArrayList<FFmpegTagEntity> tags = entity.getTags();
        if (tags == null) tags = new ArrayList<>();
        tags.add(new FFmpegTagEntity(entity.getUid(), display, FFmpegTagEntity.TYPE_LANGUAGE));
        entity.setTags(tags);
    }

    /**
     * Humanise a caption language tag: "en" -> "English",
     * "pt-BR" -> "Portuguese (Brazil)", "en-auto" -> "English (auto)" (the
     * "-auto" suffix marks YouTube ASR/auto-generated tracks). Falls back to
     * the raw code if the locale can't be resolved.
     */
    private String localizeLanguage(String code) {
        if (TextUtils.isEmpty(code)) return null;
        boolean auto = code.endsWith("-auto");
        String base = auto ? code.substring(0, code.length() - "-auto".length()) : code;
        String display = base;
        try {
            String name = Locale.forLanguageTag(base).getDisplayName();
            if (!TextUtils.isEmpty(name) && !name.equalsIgnoreCase(base)) {
                display = name;
            }
        } catch (Exception ignored) {
            // keep the raw code
        }
        return auto ? display + " (auto)" : display;
    }

    // ========================================================================
    // HLS master (niconico / Kick / Twitch)
    // ========================================================================

    /**
     * Fetch the HLS master playlist (same fetch-and-parse-in-the-task shape as
     * {@link #processSvg}) and enumerate its qualities with {@link M3U8Parser} —
     * text only, never opening a segment, so a single-use AES key is never burned
     * at capture. The parsed variants run through {@link VariantProcessor} with
     * {@code skipProbe} (no ffmpeg). On any failure (fetch error / not a master)
     * we fall back to the ffmpeg probe of the master URL.
     */
    private boolean processHlsMaster(BrowserDownloadEntity entity) throws Exception {
        String master = null;
        try {
            master = WebUtils.getString(mUrl, mRequestHeaders);
        } catch (Exception e) {
            Log.w(TAG, "HLS master fetch failed, ffmpeg fallback: " + mUrl, e);
        }
        if (TextUtils.isEmpty(master)) {
            return processFFmpeg(entity, mUrl);
        }

        JSONArray arr = M3U8Parser.parseMaster(master, mUrl);
        ArrayList<FFmpegEntity> variants = JsonHelper.parseVariants(arr, null);
        if (variants == null || variants.isEmpty()) {
            Log.w(TAG, "HLS master had no variants, ffmpeg fallback: " + mUrl);
            return processFFmpeg(entity, mUrl);
        }

        // Represent the capture by its first (best) rendition, matching the
        // variant-message convention (entity url = a playable rendition, not the
        // master). skipProbe = true: trust the parsed metadata, don't decrypt.
        String first = variants.get(0).getStreamUrl();
        if (!TextUtils.isEmpty(first)) {
            entity.setFileUrl(first);
        }
        // Came from M3U8Parser on a fetched master → definitionally HLS manifests.
        new VariantProcessor(mRequestHeaders, true, true).process(entity, variants);
        return true;
    }

    // ========================================================================
    // SVG
    // ========================================================================

    private void processSvg(BrowserDownloadEntity entity) throws Exception {
        String svgString = WebUtils.getString(mUrl, mRequestHeaders);
        if (svgString == null)
            throw new IllegalStateException("Failed to fetch SVG: " + mUrl);
        SVG svg = SVG.getFromString(svgString);
        int width = (int) svg.getDocumentWidth();
        int height = (int) svg.getDocumentHeight();

        if (width > 0 && height > 0) {
            ArrayList<FFmpegTagEntity> tags = new ArrayList<>();
            tags.add(new FFmpegTagEntity(entity.getUid(),
                    String.format(Locale.US, "%dx%d", width, height),
                    FFmpegTagEntity.TYPE_RESOLUTION));
            entity.setTags(tags);
        }
        entity.setMimeType(FileUriHelper.MIMETYPE_SVG);
        entity.setType(UrlType.SVG.getValue());
    }

    // ========================================================================
    // Tags
    // ========================================================================

    private void parseTags(BrowserDownloadEntity entity, ArrayList<FFmpegEntity> streams, String mime) {
        ArrayList<FFmpegTagEntity> tags = new ArrayList<>();
        String duration = entity.getFileDuration();
        int uid = entity.getUid();

        Log.d(TAG, "parseTags mime: " + mime + " url: " + mUrl + " info: " + streams.get(0).getInfo());
        if (FileUriHelper.isVideo(mime) || FileUriHelper.isAudio(mime)) {
            if (!TextUtils.isEmpty(duration)) {
                tags.add(new FFmpegTagEntity(uid, duration, FFmpegTagEntity.TYPE_DURATION));
            }
            if (streams.size() == 1) {
                tags.add(new FFmpegTagEntity(uid, streams.get(0).getInfo(), FFmpegTagEntity.TYPE_QUALITY));
            }
        } else if (FileUriHelper.isImage(mime) || FileUriHelper.isSVG(mime)) {
            if (!streams.isEmpty()) {
                String resolution = streams.get(0).getInfo();
                if (!TextUtils.isEmpty(resolution)) {
                    tags.add(new FFmpegTagEntity(uid, resolution, FFmpegTagEntity.TYPE_RESOLUTION));
                }
            }
        }
        entity.setTags(tags);
    }

    // ========================================================================
    // Display name
    // ========================================================================

    private void applyDisplayName(BrowserDownloadEntity entity) {
        // Subtitles and YouTube timedtext already had their filename built in
        // processSubtitle / the TIMEDTEXT branch (with optional [lang] suffix).
        // Don't let the variant/page-title rename logic overwrite them.
        if (mUrlType == UrlType.SUBTITLE || mUrlType == UrlType.TIMEDTEXT) return;

        String current = entity.getFileName();
        if (!TextUtils.isEmpty(current) && !WebUtils.isUrlDerivedName(current)) return;

        // Variant flow (Twitter / IG / YouTube) already populates mName +
        // mDescription from the parser extension. For these we keep the
        // existing "author - text" build to preserve the established
        // filename shape downstream code may depend on.
        String name = buildFileName(mName, mDescription);
        if (!TextUtils.isEmpty(name)) {
            entity.setFileName(name);
            return;
        }

        // Generic captured-media flow: the webrequests content script pushed
        // the live page title into mName (and optional meta description into
        // mDescription). Only apply for audio/video — image filenames take
        // their cue from alt text / URL slug, not the page they appeared on.
        String mime = entity.getMimeType();
        if (!FileUriHelper.isVideo(mime) && !FileUriHelper.isAudio(mime)) return;

        String hostname = null;
        try {
            hostname = android.net.Uri.parse(entity.getFileOrigin()).getHost();
        } catch (Exception ignored) {
        }
        String descriptive = WebUtils.sanitizeTitleForFilename(mName, hostname);
        if (descriptive != null) {
            entity.setFileName(descriptive);
        }
    }

    private String buildFileName(String author, String text) {
        if (TextUtils.isEmpty(text)) return author;
        String clean = text.replaceAll("https?://\\S+", "")
                .replaceAll("[\\n\\r]+", " ")
                .trim();
        if (clean.length() > 50) clean = clean.substring(0, 50).trim();
        if (TextUtils.isEmpty(clean)) return author;
        if (!TextUtils.isEmpty(author)) return author + " - " + clean;
        return clean;
    }

    // ========================================================================
    // Cleanup & utilities
    // ========================================================================

    private void cleanupFFmpeg() {
        if (mFFmpegMetaDataReader != null) {
            mFFmpegMetaDataReader.stop();
            mFFmpegMetaDataReader.release();
            mFFmpegMetaDataReader = null;
        }
    }

    private Map<String, String> safeHeaders(Map<String, String> headers) {
        if (headers == null) return new HashMap<>();
        // For TIMEDTEXT and SUBTITLE the YouTube/parser extension sets the
        // exact header set deliberately (mirroring SabrDownloader's
        // proven-working MWEB envelope). Stripping Accept / Accept-Encoding
        // / Accept-Language here breaks the response: YouTube's timedtext
        // endpoint returns HTTP 200 with an empty body when those signals
        // are missing or default. Pass them through verbatim — only the
        // hop-by-hop / context-bound headers (Host, Connection, Range) are
        // always unsafe to forward.
        Set<String> blocked = (mUrlType == UrlType.TIMEDTEXT || mUrlType == UrlType.SUBTITLE)
                ? ALWAYS_BLOCKED_HEADERS
                : BLOCKED_HEADERS;
        return headers.entrySet().stream()
                .filter(e -> !blocked.contains(e.getKey()))
                .collect(Collectors.toMap(
                        Map.Entry::getKey,
                        e -> e.getValue().replace("\n", "")
                ));
    }
}