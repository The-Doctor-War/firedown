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
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
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

import com.google.android.material.button.MaterialButton;
import com.google.android.material.progressindicator.LinearProgressIndicator;
import com.google.android.material.slider.RangeSlider;
import com.google.android.material.slider.Slider;
import com.google.android.material.snackbar.Snackbar;
import com.solarized.firedown.IntentActions;
import com.solarized.firedown.Keys;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.DownloadEntity;
import com.solarized.firedown.ffmpegutils.FFmpegGifMaker;
import com.solarized.firedown.manager.tasks.TaskManager;
import com.solarized.firedown.utils.NavigationUtils;

import java.util.ArrayList;
import java.util.Locale;

public class GifMakerFragment extends BaseFocusFragment {

    private DownloadEntity mDownloadEntity;

    private PlayerView mPlayerView;
    private ExoPlayer mExoPlayer;

    private RangeSlider mRangeSlider;
    private Slider mSpeedSlider;
    private TextView mSpeedValue;
    private TextView mRangeLabel;
    private LinearProgressIndicator mPlayheadIndicator;

    /* Slider position → fps mapping. Indexed by (int) slider value. */
    private static final int[] SPEED_FPS = {6, 8, 12, 18, 25};
    private static final int SPEED_DEFAULT_INDEX = 2;

    /* Below this, the encode either produces an empty GIF (start == end)
     * or a single-frame one that's barely a GIF — ffmpeg's gif muxer
     * rejects degenerate inputs and the native side guards too, but
     * we want to fail fast in the UI rather than start a doomed task. */
    private static final long MIN_TRIM_MS = 200L;

    private MaterialButton mCreateButton;

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
            if (mExoPlayer != null) {
                long pos = mExoPlayer.getCurrentPosition();
                if (mLastEndMs > mLastStartMs && (pos >= mLastEndMs || pos < mLastStartMs)) {
                    mExoPlayer.seekTo(mLastStartMs);
                    pos = mLastStartMs;
                }
                updatePlayhead(pos);
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
        View view = inflater.inflate(R.layout.fragment_gif_maker, container, false);

        mToolbar = view.findViewById(R.id.toolbar);
        mAppBarLayout = view.findViewById(R.id.appbar_layout);
        mPlayerView = view.findViewById(R.id.player_view);
        mRangeSlider = view.findViewById(R.id.range_slider);
        mSpeedSlider = view.findViewById(R.id.speed_slider);
        mSpeedValue = view.findViewById(R.id.speed_value);
        mRangeLabel = view.findViewById(R.id.range_label);
        mPlayheadIndicator = view.findViewById(R.id.playhead_indicator);
        mPlayheadIndicator.setMax(10000);

        return view;
    }

    @OptIn(markerClass = UnstableApi.class)
    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        /* super attaches the inset listeners on mToolbar / mNavScrim
         * (BaseFocusFragment handles top + bottom system bars), so the
         * field bindings have to happen in onCreateView before this. */
        super.onViewCreated(view, savedInstanceState);

        mToolbar.setNavigationOnClickListener(v ->
                NavigationUtils.popBackStackSafe(mNavController, R.id.gif_maker));

        mCreateButton = view.findViewById(R.id.create_button);
        mCreateButton.setOnClickListener(v -> startGifMakerTask());
        /* Disabled until the player reports STATE_READY so the duration
         * is known — otherwise the user can hit Create with the slider
         * still on its 0..100 placeholder and produce a 100 ms GIF. */
        mCreateButton.setEnabled(false);

        /* The create button is constrained to the body's bottom, which is
         * the same screen edge that navigation_scrim grows up from. On
         * gesture-bar devices the scrim is ~24dp tall, taller than the
         * button's own 16dp bottom margin, so the button sits behind it.
         * Add the system bottom inset to the button's bottom margin —
         * same approach BaseFocusFragment uses for mFab. */
        int baseBottomMargin = ((ViewGroup.MarginLayoutParams) mCreateButton.getLayoutParams())
                .bottomMargin;
        ViewCompat.setOnApplyWindowInsetsListener(mCreateButton, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            lp.bottomMargin = baseBottomMargin + bars.bottom;
            v.setLayoutParams(lp);
            return windowInsets;
        });

        configurePlayer();
        configureRangeSlider();
        configureSpeedSlider();

        mLoopHandler.postDelayed(mLoopTask, PREVIEW_LOOP_INTERVAL_MS);
    }

    /* Maps the player position onto the same horizontal axis as the range
     * slider, so the user sees the playhead sweep across the trim region
     * during the live preview. Indicator's max is 10 000 (~0.01% steps);
     * mDurationMs may not be set yet during the first few ticks before
     * the player reports STATE_READY. */
    private void updatePlayhead(long positionMs) {
        if (mPlayheadIndicator == null || mDurationMs <= 0) return;
        int progress = (int) ((positionMs * 10000L) / mDurationMs);
        if (progress < 0) progress = 0;
        if (progress > 10000) progress = 10000;
        mPlayheadIndicator.setProgressCompat(progress, true);
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

    private void configureSpeedSlider() {
        mSpeedSlider.setLabelFormatter(value -> speedLabel((int) value));
        mSpeedSlider.addOnChangeListener((slider, value, fromUser) ->
                mSpeedValue.setText(speedLabel((int) value)));
        mSpeedValue.setText(speedLabel((int) mSpeedSlider.getValue()));
    }

    private String speedLabel(int index) {
        switch (clampSpeedIndex(index)) {
            case 0: return getString(R.string.gif_maker_speed_very_slow);
            case 1: return getString(R.string.gif_maker_speed_slow);
            case 3: return getString(R.string.gif_maker_speed_fast);
            case 4: return getString(R.string.gif_maker_speed_very_fast);
            default: return getString(R.string.gif_maker_speed_medium);
        }
    }

    private static int clampSpeedIndex(int index) {
        if (index < 0) return 0;
        if (index >= SPEED_FPS.length) return SPEED_FPS.length - 1;
        return index;
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

        /* Now that we know the duration, the slider has real values and
         * the encode args will be coherent. Safe to let the user submit. */
        if (mCreateButton != null) mCreateButton.setEnabled(true);
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
        return SPEED_FPS[clampSpeedIndex((int) mSpeedSlider.getValue())];
    }

    private void startGifMakerTask() {
        if (mDownloadEntity == null) return;

        /* Player hasn't reported STATE_READY yet → mDurationMs == 0,
         * mLastEndMs == 0, slider is on its 0..100 placeholder. The
         * Create button is disabled in this state, but guard anyway in
         * case something fires through (e.g. accessibility action). */
        if (mDurationMs <= 0) {
            Snackbar.make(requireView(), R.string.gif_maker_not_ready,
                    Snackbar.LENGTH_SHORT).show();
            return;
        }

        long start = mLastStartMs;
        long end = mLastEndMs;

        /* end == 0 here would mean "encode the whole clip", which is
         * the legacy semantics the native side honours. But once the
         * duration is known we always have end > 0 from applyDuration,
         * so an end <= start range is genuinely degenerate. Reject it
         * with the same message as the too-short case to keep the UI
         * simple — both cases mean "pick a real range". */
        if (end - start < MIN_TRIM_MS) {
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
        NavigationUtils.popBackStackSafe(mNavController, R.id.gif_maker);
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
        mPlayheadIndicator = null;
        mCreateButton = null;
    }
}
