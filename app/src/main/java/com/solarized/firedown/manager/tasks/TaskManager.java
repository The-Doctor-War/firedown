package com.solarized.firedown.manager.tasks;

import android.app.Service;
import android.content.Intent;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Process;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.solarized.firedown.data.TaskEvent;
import com.solarized.firedown.data.entity.DownloadEntity;
import com.solarized.firedown.IntentActions;
import com.solarized.firedown.Keys;
import com.solarized.firedown.data.repository.DownloadDataRepository;
import com.solarized.firedown.data.repository.TaskRepository;


import java.util.ArrayList;

import javax.inject.Inject;

import dagger.hilt.android.AndroidEntryPoint;


@AndroidEntryPoint
public class TaskManager extends Service {

    private static final String TAG = TaskManager.class.getName();

    private ServiceHandler serviceHandler;

    private TaskRunnable mCurrentRunnable;

    private ArrayList<DownloadEntity> mQueueList;

    private GifMakerArgs mGifMakerArgs;

    private long mFramePosMs;

    @Inject
    DownloadDataRepository mDownloadRepository; // Injected by Hilt
    @Inject
    TaskRepository mTaskRepository; // Injected by Hilt


    // Handler that receives messages from the thread
    private final class ServiceHandler extends Handler {
        public ServiceHandler(Looper looper) {
            super(looper);
        }
        @Override
        public void handleMessage(@NonNull Message msg) {
            // Normally we would do some work here, like download a file.
            // For our sample, we just sleep for 5 seconds.
            String action = (String) msg.obj;
            Log.d(TAG, "handleMessage: " + action);
            if(IntentActions.DOWNLOAD_START_AUDIO_ENCODE.equals(action)){
                mCurrentRunnable = new AudioEncodeTask(TaskManager.this, mDownloadRepository);
                post(mCurrentRunnable);
            }else if(IntentActions.DOWNLOAD_START_MAKE_GIF.equals(action)){
                mCurrentRunnable = new GifMakerTask(TaskManager.this, mDownloadRepository);
                post(mCurrentRunnable);
            }else if(IntentActions.START_ENCRYPTION.equals(action)){
                mCurrentRunnable = new InSafeTask(TaskManager.this, mDownloadRepository);
                post(mCurrentRunnable);
            }else if(IntentActions.START_DECRYPTION.equals(action)){
                mCurrentRunnable = new OutSafeTask(TaskManager.this, mDownloadRepository);
                post(mCurrentRunnable);
            }else if(IntentActions.DOWNLOAD_START_COMPRESS.equals(action)){
                mCurrentRunnable = new CompressTask(TaskManager.this, mDownloadRepository);
                post(mCurrentRunnable);
            }else if(IntentActions.DOWNLOAD_START_EXTRACT.equals(action)){
                mCurrentRunnable = new DecompressTask(TaskManager.this, mDownloadRepository);
                post(mCurrentRunnable);
            }else if(IntentActions.DOWNLOAD_START_SAVE_FRAME.equals(action)){
                mCurrentRunnable = new SaveFrameTask(TaskManager.this, mDownloadRepository);
                post(mCurrentRunnable);
            }
            Log.d(TAG, "handleMessage End");
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        // Start up the thread running the service. Note that we create a
        // separate thread because the service normally runs in the process's
        // main thread, which we don't want to block. We also make it
        // background priority so CPU-intensive work doesn't disrupt our UI.
        HandlerThread thread = new HandlerThread("ServiceStartArguments",
                Process.THREAD_PRIORITY_BACKGROUND);
        thread.start();

        mQueueList = new ArrayList<>();

        // Get the HandlerThread's Looper and use it for our Handler
        Looper serviceLooper = thread.getLooper();
        serviceHandler = new ServiceHandler(serviceLooper);


    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {

        if(intent == null || intent.getAction() == null){
            stopSelf();
            return START_NOT_STICKY;
        }

        Message msg = serviceHandler.obtainMessage();
        msg.arg1 = startId;

        ArrayList<DownloadEntity> downloadEntities = intent.getParcelableArrayListExtra(Keys.ITEM_LIST_ID);

        if(downloadEntities != null){
            mQueueList.clear();
            mQueueList.addAll(downloadEntities);
        }

        String mAction = intent.getAction();

        if (IntentActions.DOWNLOAD_START_MAKE_GIF.equals(mAction)) {
            mGifMakerArgs = new GifMakerArgs(
                    intent.getLongExtra(Keys.GIF_START_MS, 0L),
                    intent.getLongExtra(Keys.GIF_END_MS, 0L),
                    intent.getIntExtra(Keys.GIF_FPS, 0),
                    intent.getIntExtra(Keys.GIF_WIDTH, 0));
        }

        if (IntentActions.DOWNLOAD_START_SAVE_FRAME.equals(mAction)) {
            mFramePosMs = intent.getLongExtra(Keys.FRAME_POSITION_MS, 0L);
        }

        Log.d(TAG, "onStartCommand: " + mAction);

        switch (mAction) {
            case IntentActions.DOWNLOAD_START_AUDIO_ENCODE, IntentActions.DOWNLOAD_START_MAKE_GIF,
                 IntentActions.START_DECRYPTION, IntentActions.START_ENCRYPTION,
                 IntentActions.DOWNLOAD_START_COMPRESS, IntentActions.DOWNLOAD_START_EXTRACT,
                 IntentActions.DOWNLOAD_START_SAVE_FRAME -> {
                msg.obj = mAction;
                serviceHandler.sendMessage(msg);
            }
            case IntentActions.DOWNLOAD_CANCEL_AUDIO_ENCODE, IntentActions.DOWNLOAD_CANCEL_MAKE_GIF,
                 IntentActions.CANCEL_DECRYPTION, IntentActions.CANCEL_ENCRYPTION,
                 IntentActions.DOWNLOAD_CANCEL_COMPRESS, IntentActions.DOWNLOAD_CANCEL_EXTRACT,
                 IntentActions.DOWNLOAD_CANCEL_SAVE_FRAME -> {
                if(mCurrentRunnable != null){
                    mCurrentRunnable.stop();
                }
                // Stop the service using the startId, so that we don't stop
                // the service in the middle of handling another job
            }
        }

        // If we get killed, after returning from here, restart
        return START_STICKY;
    }


    public void deliverMessage(TaskEvent taskEvent) {
        mTaskRepository.sendEvent(taskEvent);
    }

    public ArrayList<DownloadEntity> getQueueList(){
        return mQueueList;
    }

    public GifMakerArgs getGifMakerArgs() {
        return mGifMakerArgs;
    }

    public long getFramePosMs() {
        return mFramePosMs;
    }

}
