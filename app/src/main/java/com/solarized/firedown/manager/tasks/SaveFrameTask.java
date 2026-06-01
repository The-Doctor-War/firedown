package com.solarized.firedown.manager.tasks;

import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.util.Log;

import com.solarized.firedown.data.Download;
import com.solarized.firedown.data.TaskEvent;
import com.solarized.firedown.data.entity.DownloadEntity;
import com.solarized.firedown.data.repository.DownloadDataRepository;
import com.solarized.firedown.ffmpegutils.FFmpegThumbnailer;
import com.solarized.firedown.manager.ServiceActions;
import com.solarized.firedown.utils.FileUriHelper;
import com.solarized.firedown.StoragePaths;

import org.apache.commons.io.FilenameUtils;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.UUID;

/**
 * Grabs a single still frame from a video at a chosen position and writes
 * it as a JPEG into the download folder, registering it as a finished
 * download. Reuses the {@link TaskRunnable} machinery (Started / Finished
 * events, bottom progress bar) like the GIF / compress tasks.
 *
 * <p>The frame is decoded with {@link MediaMetadataRetriever} (its
 * time-based {@code OPTION_CLOSEST_SYNC} seek is reliable for arbitrary
 * mid-clip positions). {@link FFmpegThumbnailer} is only a position-0
 * fallback for codecs Android's MediaCodec can't decode (e.g. AV1 on older
 * devices) — its native seek uses {@code AVSEEK_FLAG_ANY} and bails to EOF
 * for non-zero positions, so it can't honour an arbitrary timestamp.
 */
public class SaveFrameTask extends TaskRunnable {

    private static final String TAG = SaveFrameTask.class.getSimpleName();

    private static final int JPEG_QUALITY = 95;

    private final DownloadDataRepository mDownloadRepository;
    private final TaskManager mTaskManager;

    public SaveFrameTask(TaskManager taskManager, DownloadDataRepository downloadDataRepository) {
        super(taskManager);
        mTaskManager = taskManager;
        mDownloadRepository = downloadDataRepository;
    }

    @Override
    public void stoppableRun() {

        final ArrayList<DownloadEntity> mQueueList = getQueueList();

        if (mQueueList == null || mQueueList.isEmpty()) {
            Log.w(TAG, "Empty Queue");
            return;
        }

        DownloadEntity source = mQueueList.get(0);
        if (source.getFilePath() == null) {
            Log.w(TAG, "Null source path");
            return;
        }

        File outFile = null;
        boolean success = false;

        deliverMessage(new TaskEvent.Started(ServiceActions.SAVE_FRAME));

        try {
            StoragePaths.ensureDownloadPath(mTaskManager);

            long posMs = mTaskManager.getFramePosMs();
            String filePath = source.getFilePath();

            Bitmap frame = grabFrame(filePath, posMs);
            if (frame == null || isStopped() || Thread.interrupted()) {
                return;
            }

            String base = FilenameUtils.getBaseName(filePath);
            outFile = ensureFilePath(new File(StoragePaths.getDownloadPath(mTaskManager),
                    base + "_frame.jpg").getAbsolutePath());

            try (FileOutputStream out = new FileOutputStream(outFile)) {
                if (!frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) {
                    Log.w(TAG, "Bitmap.compress returned false");
                    return;
                }
            } finally {
                frame.recycle();
            }

            mDownloadRepository.addSync(buildEntity(source, outFile));
            success = true;
            deliverMessage(new TaskEvent.Finished(ServiceActions.SAVE_FRAME, null));

        } catch (IOException e) {
            Log.e(TAG, "saveFrame", e);
        } finally {
            if (!success) {
                if (outFile != null) outFile.delete();
                deliverMessage(new TaskEvent.Finished(
                        isStopped() ? ServiceActions.CANCEL_SAVE_FRAME : ServiceActions.ERROR_SAVE_FRAME,
                        null));
            }
            stopService();
            Log.d(TAG, "Finished");
        }
    }

    /** Full-resolution frame at {@code posMs}; FFmpeg fallback at pos 0. */
    private Bitmap grabFrame(String filePath, long posMs) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(filePath);
            Bitmap bmp = retriever.getFrameAtTime(posMs * 1000L,
                    MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (bmp != null) return bmp;
            Log.w(TAG, "MMR null at " + posMs + "ms; trying FFmpegThumbnailer (pos 0)");
        } catch (Throwable t) {
            Log.e(TAG, "MMR extraction failed", t);
        } finally {
            try { retriever.release(); } catch (Throwable ignored) { }
        }

        FFmpegThumbnailer thumb = new FFmpegThumbnailer();
        try {
            if (thumb.setDataSource(filePath, null) < 0) return null;
            return thumb.getBitmap(0L);
        } catch (Throwable t) {
            Log.e(TAG, "FFmpegThumbnailer fallback failed", t);
            return null;
        } finally {
            try { thumb.release(); } catch (Throwable ignored) { }
        }
    }

    /** A finished image download for the saved frame. */
    private DownloadEntity buildEntity(DownloadEntity source, File outFile) {
        DownloadEntity entity = new DownloadEntity();
        entity.setId(UUID.randomUUID().hashCode());
        entity.setFileName(outFile.getName());
        entity.setFilePath(outFile.getAbsolutePath());
        entity.setFileMimeType(FileUriHelper.MIMETYPE_JPEG);
        entity.setFileSize(outFile.length());
        entity.setFileDate(System.currentTimeMillis());
        entity.setFileOriginUrl(source.getOriginUrl());
        entity.setFileStatus(Download.FINISHED);
        entity.setFileThumbnailUnavailable(false);
        return entity;
    }
}
