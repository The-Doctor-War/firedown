package com.solarized.firedown.phone.fragments;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.fragment.app.Fragment;
import androidx.media3.common.MediaItem;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.FileDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ExtractorsFactory;
import androidx.media3.ui.PlayerView;

import com.google.android.material.slider.RangeSlider;
import com.google.android.material.slider.Slider;
import com.solarized.firedown.Keys;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.DownloadEntity;
import com.solarized.firedown.ffmpegutils.FFmpegGifMaker;

import java.util.Locale;

public class GifMakerFragment extends Fragment {

    private DownloadEntity mDownloadEntity;

    private PlayerView mPlayerView;
    private ExoPlayer mExoPlayer;

    private RangeSlider mRangeSlider;
    private Slider mFpsSlider;
    private Slider mWidthSlider;
    private TextView mRangeLabel;
    private TextView mFpsLabel;
    private TextView mWidthLabel;

    /* Cached duration in ms — populated from the player once it's ready.
     * Until then the slider operates on the placeholder 0..100 range from
     * the layout. */
    private long mDurationMs;

    /* RangeSlider's onChange callback reports the new value for whichever
     * thumb moved but doesn't say which one. Tracking the previous values
     * lets us diff and seek the player only to the thumb that actually
     * changed — otherwise dragging the end thumb would jump the preview
     * past the start. */
    private long mLastStartMs;
    private long mLastEndMs;


    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Bundle bundle = getArguments();
        if (bundle == null) {
            throw new IllegalArgumentException("GifMakerFragment requires a DownloadEntity");
        }
        mDownloadEntity = bundle.getParcelable(Keys.ITEM_ID);
        if (mDownloadEntity == null) {
            throw new IllegalArgumentException("GifMakerFragment requires a DownloadEntity");
        }
    }

    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        return inflater.inflate(R.layout.fragment_gif_maker, container, false);
    }

    @OptIn(markerClass = UnstableApi.class)
    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);

        mPlayerView = view.findViewById(R.id.player_view);
        mRangeSlider = view.findViewById(R.id.range_slider);
        mFpsSlider = view.findViewById(R.id.fps_slider);
        mWidthSlider = view.findViewById(R.id.width_slider);
        mRangeLabel = view.findViewById(R.id.range_label);
        mFpsLabel = view.findViewById(R.id.fps_label);
        mWidthLabel = view.findViewById(R.id.width_label);

        Context context = requireContext();

        mExoPlayer = new ExoPlayer.Builder(context).build();
        mPlayerView.setPlayer(mExoPlayer);

        DataSource.Factory dataSourceFactory = new FileDataSource.Factory();
        ExtractorsFactory extractorsFactory = new DefaultExtractorsFactory()
                .setConstantBitrateSeekingEnabled(true)
                .setConstantBitrateSeekingAlwaysEnabled(true);

        MediaItem mediaItem = MediaItem.fromUri(Uri.parse(mDownloadEntity.getFilePath()));
        MediaSource source = new ProgressiveMediaSource.Factory(dataSourceFactory, extractorsFactory)
                .createMediaSource(mediaItem);

        mExoPlayer.setMediaSource(source);
        mExoPlayer.prepare();
        mExoPlayer.setPlayWhenReady(false);

        mExoPlayer.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                /* Duration is only known once the player has finished
                 * preparation. Configure the range slider then; the user
                 * could start adjusting before this fires, but the layout
                 * defaults give them a usable 0..100 placeholder. */
                if (playbackState == Player.STATE_READY && mDurationMs <= 0) {
                    long duration = mExoPlayer.getDuration();
                    if (duration > 0) {
                        configureRangeSlider(duration);
                    }
                }
            }
        });

        mRangeSlider.addOnChangeListener((slider, value, fromUser) -> {
            updateRangeLabel();
            if (fromUser && slider.getValues().size() >= 2) {
                long start = slider.getValues().get(0).longValue();
                long end = slider.getValues().get(1).longValue();
                if (start != mLastStartMs) {
                    mExoPlayer.seekTo(start);
                } else if (end != mLastEndMs) {
                    mExoPlayer.seekTo(end);
                }
                mLastStartMs = start;
                mLastEndMs = end;
            }
        });

        mFpsSlider.addOnChangeListener((slider, value, fromUser) -> updateFpsLabel());
        mWidthSlider.addOnChangeListener((slider, value, fromUser) -> updateWidthLabel());

        updateRangeLabel();
        updateFpsLabel();
        updateWidthLabel();
    }

    private void configureRangeSlider(long durationMs) {
        /* Material RangeSlider requires (valueTo - valueFrom) to be a
         * multiple of stepSize, and rejects the configuration with
         * IllegalStateException otherwise. Round the duration down to the
         * nearest 100 ms before publishing it as the slider's max so a
         * 9:30.86 video doesn't crash the screen. */
        long rounded = (durationMs / 100L) * 100L;
        if (rounded < 100L) rounded = 100L;
        mDurationMs = rounded;

        mRangeSlider.setValueFrom(0f);
        mRangeSlider.setValueTo((float) rounded);
        mRangeSlider.setStepSize(100f);
        mRangeSlider.setValues(0f, (float) rounded);
        mLastStartMs = 0L;
        mLastEndMs = rounded;
        updateRangeLabel();
    }

    private void updateRangeLabel() {
        if (mRangeSlider.getValues().size() < 2) return;
        long start = mRangeSlider.getValues().get(0).longValue();
        long end = mRangeSlider.getValues().get(1).longValue();
        long span = Math.max(0, end - start);
        mRangeLabel.setText(String.format(Locale.getDefault(),
                "%s → %s (%s)",
                formatTime(start), formatTime(end), formatDuration(span)));
    }

    private void updateFpsLabel() {
        mFpsLabel.setText(getString(R.string.gif_maker_fps_label, (int) mFpsSlider.getValue()));
    }

    private void updateWidthLabel() {
        mWidthLabel.setText(getString(R.string.gif_maker_width_label, (int) mWidthSlider.getValue()));
    }

    private static String formatTime(long ms) {
        long s = ms / 1000;
        return String.format(Locale.getDefault(), "%02d:%02d", s / 60, s % 60);
    }

    private static String formatDuration(long ms) {
        long s = (ms + 500) / 1000;
        return s + "s";
    }

    /* Called by GifMakerActivity when the user taps the toolbar Create
     * action. Pulls the current slider state into the holder the activity
     * uses to build the start-task intent. */
    public Args collectArgs() {
        long start = 0L;
        long end = 0L;
        if (mRangeSlider.getValues().size() >= 2) {
            start = mRangeSlider.getValues().get(0).longValue();
            end = mRangeSlider.getValues().get(1).longValue();
        }
        int fps = (int) mFpsSlider.getValue();
        int width = (int) mWidthSlider.getValue();
        if (fps <= 0) fps = FFmpegGifMaker.DEFAULT_FPS;
        if (width <= 0) width = FFmpegGifMaker.DEFAULT_WIDTH;
        return new Args(start, end, fps, width);
    }

    public DownloadEntity getDownloadEntity() {
        return mDownloadEntity;
    }

    @Override
    public void onPause() {
        super.onPause();
        if (mExoPlayer != null) mExoPlayer.pause();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (mPlayerView != null) mPlayerView.setPlayer(null);
        if (mExoPlayer != null) mExoPlayer.release();
        mExoPlayer = null;
        mPlayerView = null;
    }

    public static final class Args {
        public final long startMs;
        public final long endMs;
        public final int fps;
        public final int width;

        Args(long startMs, long endMs, int fps, int width) {
            this.startMs = startMs;
            this.endMs = endMs;
            this.fps = fps;
            this.width = width;
        }
    }
}
