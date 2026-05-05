package com.solarized.firedown.manager.tasks;

/**
 * Trim + encode parameters carried from the GIF-maker UI to {@link GifMakerTask}.
 *
 * <p>{@link com.solarized.firedown.manager.tasks.TaskManager TaskManager} only
 * forwards the parcelable entity list through its intents — anything else
 * has to ride on the side. This holder is the side channel: TaskManager
 * pulls these four scalars out of the start-intent extras and stashes them
 * for GifMakerTask to consume.
 */
public final class GifMakerArgs {

    public final long startMs;
    public final long endMs;
    public final int fps;
    public final int width;

    public GifMakerArgs(long startMs, long endMs, int fps, int width) {
        this.startMs = startMs;
        this.endMs = endMs;
        this.fps = fps;
        this.width = width;
    }
}
