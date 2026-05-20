package com.solarized.firedown.crash;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.HashMap;
import java.util.Map;

/**
 * Receives crash notifications from GeckoView when a Gecko child
 * process dies. Declared in {@code AndroidManifest.xml} with
 * {@code android:process=":crash"} so it runs in its own process —
 * the main app process may already be dead by the time we start.
 *
 * <p>Reads the extras file Mozilla writes alongside the minidump
 * (plain text {@code Key=Value} lines, one per row, same format
 * Breakpad's crashreporter emits) and persists a {@link CrashReport}
 * to {@link CrashStorage}, where the main process picks it up on
 * the next launch.</p>
 *
 * <p>The {@code minidumpPath} is recorded but not uploaded — minidumps
 * are binary Breakpad blobs that can't be inlined into a GitHub issue
 * URL. The path stays in the report so the user can attach it
 * manually if a maintainer asks.</p>
 *
 * <p>Wired in {@link com.solarized.firedown.geckoview.GeckoRuntimeHelper}
 * via {@code crashHandler(GeckoCrashHandlerService.class)}.</p>
 */
public class GeckoCrashHandlerService extends Service {

    private static final String TAG = "GeckoCrashHandler";

    // org.mozilla.geckoview.GeckoRuntime extras (constant values per
    // mozilla-central). Hard-coded as strings rather than pulled from
    // GeckoRuntime.* to keep the GeckoView dependency optional in this
    // process — the :crash process gets a slimmer classloader.
    private static final String EXTRA_MINIDUMP_PATH = "minidumpPath";
    private static final String EXTRA_EXTRAS_PATH = "extrasPath";
    private static final String EXTRA_PROCESS_VISIBILITY = "processVisibility";
    private static final String EXTRA_PROCESS_TYPE = "processType";
    private static final String EXTRA_REMOTE_TYPE = "remoteType";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            handle(intent);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to record Gecko crash", t);
        }
        stopSelf(startId);
        return START_NOT_STICKY;
    }

    private void handle(@Nullable Intent intent) {
        if (intent == null) return;

        String minidump = intent.getStringExtra(EXTRA_MINIDUMP_PATH);
        String extrasPath = intent.getStringExtra(EXTRA_EXTRAS_PATH);
        String visibility = intent.getStringExtra(EXTRA_PROCESS_VISIBILITY);
        String processType = intent.getStringExtra(EXTRA_PROCESS_TYPE);
        String remoteType = intent.getStringExtra(EXTRA_REMOTE_TYPE);

        Map<String, String> extras = readExtras(extrasPath);
        // Stamp the intent-level fields into the extras so they round-trip
        // through CrashReport.fromGecko's key=value list.
        if (visibility != null) extras.put("ProcessVisibility", visibility);
        if (remoteType != null) extras.put("RemoteType", remoteType);

        String origin = processType != null ? processType
                : (visibility != null ? visibility : "gecko");

        CrashReport report = CrashReport.fromGecko(origin, extras, minidump);
        CrashStorage.write(this, report);
    }

    private Map<String, String> readExtras(@Nullable String path) {
        Map<String, String> out = new HashMap<>();
        if (path == null || path.isEmpty()) return out;
        File f = new File(path);
        if (!f.exists() || !f.canRead()) return out;

        try (BufferedReader r = new BufferedReader(new FileReader(f))) {
            String line;
            while ((line = r.readLine()) != null) {
                int eq = line.indexOf('=');
                if (eq <= 0) continue;
                String key = line.substring(0, eq);
                String value = line.substring(eq + 1);
                out.put(key, value);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Failed to read Gecko extras at " + path, t);
        }
        return out;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }
}
