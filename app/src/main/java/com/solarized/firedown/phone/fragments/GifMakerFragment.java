package com.solarized.firedown.phone.fragments;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.appcompat.widget.Toolbar;
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
import androidx.navigation.fragment.NavHostFragment;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.chip.ChipGroup;
import com.google.android.material.slider.RangeSlider;
import com.google.android.material.snackbar.Snackbar;
import com.solarized.firedown.IntentActions;
import com.solarized.firedown.Keys;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.DownloadEntity;
import com.solarized.firedown.ffmpegutils.FFmpegGifMaker;
import com.solarized.firedown.manager.tasks.TaskManager;

import java.util.ArrayList;
import java.util.Locale;

public class GifMakerFragment extends Fragment {

    private DownloadEntity mDownloadEntity;

    private PlayerView mPlayerView;
    private ExoPlayer mExoPlayer;

    private RangeSlider mRangeSlider;
    private ChipGroup mSpeedChipGroup;
    private TextView mRangeLabel;

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

    /* Live preview: poll the player position and snap it back to the
     * start thumb whenever it crosses the end thumb, so the user always
     * sees exactly what's going to land in the GIF. ExoPlayer doesn't
     * have a "loop between A and B" primitive — ClippingMediaSource
     * exists but re-prepares the pipeline on every range change, which
     * is way too costly for a slider that updates 10×/second. */
    private static final long PREVIEW_LOOP_INTERVAL_MS = 250L;
    private final Handler mLoopHandler = new Handler(Looper.getMainLooper());
    private final Runnable mLoopTask = new Runnable() {
        @Override
        public void run() {
            if (mExoPlayer != null && mLastEndMs > mLastStartMs) {
                long pos = mExoPlayer.getCurrentPosition();
                if (pos >= mLastEndMs || pos < mLastStartMs) {
                    mExoPlayer.seekTo(mLastStartMs);
                }
            }
            mLoopHandler.postDelayed(this, PREVIEW_LOOP_INTERVAL_MS);
        }
    };


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

        Toolbar toolbar = view.findViewById(R.id.toolbar);
        toolbar.setNavigationOnClickListener(v ->
                NavHostFragment.findNavController(this).popBackStack());

        MaterialButton createButton = view.findViewById(R.id.create_button);
        createButton.setOnClickListener(v -> startGifMakerTask());

        mPlayerView = view.findViewById(R.id.player_view);
        mRangeSlider = view.findViewById(R.id.range_slider);
        mSpeedChipGroup = view.findViewById(R.id.speed_chip_group);
        mRangeLabel = view.findViewById(R.id.range_label);

        configurePlayer();
        configureRangeSlider();
        configureSpeedChips();

        mLoopHandler.postDelayed(mLoopTask, PREVIEW_LOOP_INTERVAL_MS);
    }

    @OptIn(markerClass = UnstableApi.class)
    private void configurePlayer() {
        mExoPlayer = new ExoPlayer.Builder(requireContext()).build();
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
        /* Don't autoplay — the user opens this screen to set up the trim,
         * not to immediately blast audio. They can hit play in the player
         * controls when they want to verify the loop. */
        mExoPlayer.setPlayWhenReady(false);

        mExoPlayer.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY && mDurationMs <= 0) {
                    long duration = mExoPlayer.getDuration();
                    if (duration > 0) {
                        applyDuration(duration);
                    }
                }
            }
        });

        /* The settings (gear) button is built into media3's default
         * controller layout and there's no public attribute to suppress
         * it — find it by id and hide. show_subtitle_button and
         * show_shuffle_button are handled via XML attributes; the repeat
         * (loop) button is hidden by simply not setting
         * app:repeat_toggle_modes (the default is "none"). */
        View settings = mPlayerView.findViewById(androidx.media3.ui.R.id.exo_settings);
        if (settings != null) settings.setVisibility(View.GONE);
    }

    private void configureRangeSlider() {
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
        updateRangeLabel();
    }

    private void configureSpeedChips() {
        /* ChipGroup with selectionRequired keeps at least one chip checked,
         * but guard anyway in case the layout default ever drifts. */
        if (mSpeedChipGroup.getCheckedChipId() == View.NO_ID) {
            mSpeedChipGroup.check(R.id.speed_medium);
        }
    }

    private void applyDuration(long durationMs) {
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
        if (mRangeSlider.getValues().size() < 2) {
            mRangeLabel.setText(formatTime(0) + " → " + formatTime(0) + " (0s)");
            return;
        }
        long start = mRangeSlider.getValues().get(0).longValue();
        long end = mRangeSlider.getValues().get(1).longValue();
        long span = Math.max(0L, end - start);
        mRangeLabel.setText(String.format(Locale.getDefault(),
                "%s → %s (%s)",
                formatTime(start), formatTime(end), formatDuration(span)));
    }

    private static String formatTime(long ms) {
        long s = ms / 1000L;
        return String.format(Locale.getDefault(), "%02d:%02d", s / 60L, s % 60L);
    }

    private static String formatDuration(long ms) {
        long s = (ms + 500L) / 1000L;
        return s + "s";
    }

    private int currentFps() {
        int id = mSpeedChipGroup.getCheckedChipId();
        if (id == R.id.speed_very_slow) return 6;
        if (id == R.id.speed_slow) return 8;
        if (id == R.id.speed_fast) return 18;
        if (id == R.id.speed_very_fast) return 25;
        return 12; /* speed_medium / fallback */
    }

    private void startGifMakerTask() {
        if (mDownloadEntity == null) return;

        long start = mLastStartMs;
        long end = mLastEndMs;

        if (end > 0 && end <= start) {
            Snackbar.make(requireView(), R.string.gif_maker_invalid_range,
                    Snackbar.LENGTH_LONG).show();
            return;
        }

        ArrayList<DownloadEntity> entities = new ArrayList<>(1);
        entities.add(mDownloadEntity);

        Intent intent = new Intent(requireContext(), TaskManager.class);
        intent.setAction(IntentActions.DOWNLOAD_START_MAKE_GIF);
        intent.putExtra(Keys.ITEM_LIST_ID, entities);
        intent.putExtra(Keys.GIF_START_MS, start);
        intent.putExtra(Keys.GIF_END_MS, end);
        intent.putExtra(Keys.GIF_FPS, currentFps());
        intent.putExtra(Keys.GIF_WIDTH, FFmpegGifMaker.DEFAULT_WIDTH);
        requireContext().startService(intent);

        /* Hand control back to the downloads list so the bottom progress
         * view shows the encode in progress. */
        NavHostFragment.findNavController(this).popBackStack();
    }

    @Override
    public void onPause() {
        super.onPause();
        if (mExoPlayer != null) mExoPlayer.pause();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        mLoopHandler.removeCallbacks(mLoopTask);
        if (mPlayerView != null) mPlayerView.setPlayer(null);
        if (mExoPlayer != null) mExoPlayer.release();
        mExoPlayer = null;
        mPlayerView = null;
    }
}
