package com.solarized.firedown.geckoview;

import com.solarized.firedown.ffmpegutils.FFmpegMetaDataReader;

/**
 * Lets a running {@link GeckoInspectTask} register the {@link FFmpegMetaDataReader}
 * it is currently blocked inside, so a tab-close cancellation can interrupt that
 * probe (see {@link GeckoInspectTask#cancel()} and {@code VariantProcessor}).
 *
 * <p>Top-level rather than nested in {@link GeckoInspectTask}: a class cannot
 * implement its own nested interface — javac reports "cyclic inheritance"
 * because resolving the class's supertype list would require the class itself.
 */
interface ProbeRegistry {
    void setActiveReader(FFmpegMetaDataReader reader);
}
