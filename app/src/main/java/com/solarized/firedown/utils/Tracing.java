package com.solarized.firedown.utils;

import android.os.Trace;

import com.solarized.firedown.BuildConfig;

/**
 * Thin wrapper around {@link android.os.Trace} that compiles to nothing
 * in release builds. Use at hot-path entry/exit points so a debug-build
 * Perfetto trace shows our method names on the main-thread slices track
 * (use the perfetto command's {@code --app com.solarized.firedown} flag
 * to surface them) without paying for the constant {@code Trace.isEnabled()}
 * check that {@code android.os.Trace} performs in production.
 *
 * <p>Mechanics: {@link BuildConfig#DEBUG} is a {@code public static final
 * boolean} known at compile time. In release, R8 folds the conditional to
 * {@code false}, inlines these tiny static methods, dead-code-eliminates
 * the {@link Trace#beginSection(String)} / {@link Trace#endSection()}
 * calls, then DCE's the now-empty call sites — including the
 * {@code try / finally} skeleton wrapping them.</p>
 *
 * <p>Convention: paired {@link #begin(String)} / {@link #end()} calls
 * MUST sit inside a {@code try { ... } finally { ... }} so an exception
 * doesn't leak an open section into the next bind. The compiled-away
 * release path makes the wrapper free; the structure stays for the
 * debug path's correctness.</p>
 */
public final class Tracing {
    private Tracing() {}

    public static void begin(String sectionName) {
        if (BuildConfig.DEBUG) Trace.beginSection(sectionName);
    }

    public static void end() {
        if (BuildConfig.DEBUG) Trace.endSection();
    }
}
