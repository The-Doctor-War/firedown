package com.solarized.firedown.crash;

import android.os.Build;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.solarized.firedown.App;
import com.solarized.firedown.BuildConfig;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Map;

/**
 * Structured crash report. Built from either a Java {@link Throwable}
 * (main process, caught by {@link CrashHandler}) or from the extras
 * bundle GeckoView passes to {@link GeckoCrashHandlerService} when a
 * Gecko child process dies.
 *
 * <p>Serialized as JSON to {@code filesDir/crashes/} so both processes
 * can write to a shared location. {@link CrashStorage} owns the I/O;
 * this class is just the shape.</p>
 */
public final class CrashReport {

    public static final String TYPE_JAVA = "java";
    public static final String TYPE_GECKO = "gecko";

    public final long timestamp;
    public final String type;          // TYPE_JAVA or TYPE_GECKO
    public final String versionName;
    public final int versionCode;
    public final String device;
    public final String abi;
    public final int sdk;
    public final String installSource;

    /** Java thread name (TYPE_JAVA) or Gecko process type (TYPE_GECKO). */
    public final String origin;

    /** Stack trace text for Java, or formatted extras for Gecko. */
    public final String trace;

    /** Optional path to the Breakpad minidump (Gecko only). */
    @Nullable
    public final String minidumpPath;

    private CrashReport(long timestamp, String type, String versionName, int versionCode,
                        String device, String abi, int sdk, String installSource,
                        String origin, String trace, @Nullable String minidumpPath) {
        this.timestamp = timestamp;
        this.type = type;
        this.versionName = versionName;
        this.versionCode = versionCode;
        this.device = device;
        this.abi = abi;
        this.sdk = sdk;
        this.installSource = installSource;
        this.origin = origin;
        this.trace = trace;
        this.minidumpPath = minidumpPath;
    }

    public static CrashReport fromThrowable(@NonNull Thread thread, @NonNull Throwable t) {
        StringWriter sw = new StringWriter();
        t.printStackTrace(new PrintWriter(sw));
        return new CrashReport(
                System.currentTimeMillis(),
                TYPE_JAVA,
                safeVersionName(),
                safeVersionCode(),
                Build.MANUFACTURER + " " + Build.MODEL,
                primaryAbi(),
                Build.VERSION.SDK_INT,
                safeInstallSource(),
                thread.getName(),
                sw.toString(),
                null);
    }

    public static CrashReport fromGecko(@NonNull String processType,
                                        @NonNull Map<String, String> extras,
                                        @Nullable String minidumpPath) {
        StringBuilder sb = new StringBuilder();
        // Sort keys for stable ordering — easier to diff between reports.
        java.util.List<String> keys = new java.util.ArrayList<>(extras.keySet());
        java.util.Collections.sort(keys);
        for (String k : keys) {
            sb.append(k).append('=').append(extras.get(k)).append('\n');
        }
        return new CrashReport(
                System.currentTimeMillis(),
                TYPE_GECKO,
                safeVersionName(),
                safeVersionCode(),
                Build.MANUFACTURER + " " + Build.MODEL,
                primaryAbi(),
                Build.VERSION.SDK_INT,
                safeInstallSource(),
                processType,
                sb.toString(),
                minidumpPath);
    }

    public JSONObject toJson() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("timestamp", timestamp);
        o.put("type", type);
        o.put("versionName", versionName);
        o.put("versionCode", versionCode);
        o.put("device", device);
        o.put("abi", abi);
        o.put("sdk", sdk);
        o.put("installSource", installSource);
        o.put("origin", origin);
        o.put("trace", trace);
        if (minidumpPath != null) o.put("minidumpPath", minidumpPath);
        return o;
    }

    public static CrashReport fromJson(JSONObject o) throws JSONException {
        return new CrashReport(
                o.getLong("timestamp"),
                o.getString("type"),
                o.optString("versionName", ""),
                o.optInt("versionCode", 0),
                o.optString("device", ""),
                o.optString("abi", ""),
                o.optInt("sdk", 0),
                o.optString("installSource", ""),
                o.optString("origin", ""),
                o.optString("trace", ""),
                o.has("minidumpPath") ? o.optString("minidumpPath") : null);
    }

    /**
     * Short one-line summary used in the snackbar title and as the
     * GitHub issue title prefix. Picks the first non-empty line of the
     * trace and trims to a reasonable length.
     */
    public String headline() {
        if (trace == null || trace.isEmpty()) return type;
        String[] lines = trace.split("\\r?\\n", 2);
        String first = lines[0].trim();
        if (first.length() > 120) first = first.substring(0, 117) + "...";
        return first;
    }

    // ── Static helpers that fall back gracefully when called from the
    //    crash handler process where the Application may not be ready.

    private static String safeVersionName() {
        try { return App.getVersionName(); } catch (Throwable ignored) {}
        return BuildConfig.VERSION_NAME;
    }

    private static int safeVersionCode() {
        try { return App.getVersionCode(); } catch (Throwable ignored) {}
        return BuildConfig.VERSION_CODE;
    }

    private static String safeInstallSource() {
        try { return App.getInstalledSource(); } catch (Throwable ignored) {}
        return "";
    }

    private static String primaryAbi() {
        String[] abis = Build.SUPPORTED_ABIS;
        return abis != null && abis.length > 0 ? abis[0] : "";
    }
}
