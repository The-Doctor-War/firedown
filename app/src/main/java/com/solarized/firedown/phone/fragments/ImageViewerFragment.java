package com.solarized.firedown.phone.fragments;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.ActionBar;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.fragment.app.Fragment;
import com.bumptech.glide.Glide;
import com.bumptech.glide.load.DataSource;
import com.bumptech.glide.load.engine.DiskCacheStrategy;
import com.bumptech.glide.load.engine.GlideException;
import com.bumptech.glide.load.resource.gif.GifDrawable;
import com.bumptech.glide.request.RequestListener;
import com.bumptech.glide.request.RequestOptions;
import com.bumptech.glide.request.target.Target;
import com.google.android.material.progressindicator.CircularProgressIndicator;
import com.google.android.material.snackbar.Snackbar;
import com.solarized.firedown.App;
import com.solarized.firedown.GlideRequestOptions;
import com.solarized.firedown.phone.PlayerActivity;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.DownloadEntity;
import com.solarized.firedown.ui.ZoomableImageView;
import com.solarized.firedown.utils.FileUriHelper;
import com.solarized.firedown.Keys;

public class ImageViewerFragment extends Fragment {

    private static final String TAG = ImageViewerFragment.class.getSimpleName();

    private DownloadEntity mDownloadEntity;

    private PlayerActivity mActivity;

    private ZoomableImageView mPhotoView;

    private CircularProgressIndicator mProgress;

    @Override
    public void onDestroyView() {
        super.onDestroyView();
        mPhotoView= null;
        mProgress = null;
    }

    @Override
    public void onAttach(@NonNull Context context) {
        super.onAttach(context);
        if (context instanceof PlayerActivity)
            mActivity = (PlayerActivity) context;
    }

    @Override
    public void onDetach() {
        super.onDetach();
        mActivity = null;
    }


    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Bundle bundle = getArguments();

        if (bundle == null)
            throw new IllegalArgumentException();

        mDownloadEntity = bundle.getParcelable(Keys.ITEM_ID);


    }

    @Override
    public View onCreateView(LayoutInflater inflater, ViewGroup container,
                             Bundle savedInstanceState) {

        postponeEnterTransition();

        Log.d(TAG, "onCreateView");
        // Inflate the layout for this fragment
        View v = inflater.inflate(R.layout.fragment_image_viewer, container, false);

        mProgress = v.findViewById(R.id.photo_progress);

        mPhotoView = v.findViewById(R.id.photo_view);

        ViewCompat.setTransitionName(mPhotoView, "image_view");

        WindowInsetsControllerCompat windowInsetsController = WindowCompat.getInsetsController(mActivity.getWindow(), mActivity.getWindow().getDecorView());

        // Configure the behavior of the hidden system bars.
        windowInsetsController.setSystemBarsBehavior(
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        );

        mPhotoView.setOnClickListener(v1 -> {
            View decorView = mActivity.getWindow().getDecorView();
            // Hide the status bar.
            int uiOptions = View.SYSTEM_UI_FLAG_FULLSCREEN;
            decorView.setSystemUiVisibility(uiOptions);
            // Remember that you should never show the action bar if the
            // status bar is hidden, so hide that too if necessary.
            ActionBar actionBar = mActivity.getSupportActionBar();

            if(actionBar != null){

               // actionBar.setBackgroundDrawable(new ColorDrawable(ContextCompat.getColor(mActivity, R.color.black_black_transparent)));

                if(actionBar.isShowing()){
                    windowInsetsController.hide(WindowInsetsCompat.Type.systemBars());
                    actionBar.hide();
                }else{
                    windowInsetsController.show(WindowInsetsCompat.Type.systemBars());
                    actionBar.show();
                }
            }
        });


        return v;

    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);

        String filePath = mDownloadEntity.getFilePath();

        String mimeType = mDownloadEntity.getFileMimeType();

        long interval = mDownloadEntity.getThumbnailDuration();

        if(FileUriHelper.isGIF(mimeType)) {
            /* asGif() forces Glide down the StreamGifDecoder /
             * ByteBufferGifDecoder path which produces a GifDrawable
             * (animated). Without this, Glide's auto-selection picks
             * a generic Bitmap decoder for the file and the GIF
             * shows as a single static frame. The .frame() option
             * the JPEG / video paths use is dropped for GIFs because
             * it's a video-frame-extraction hint that steers decoders
             * toward static output.
             *
             * Listener has to be GifDrawable-typed since asGif()
             * narrows the result type — keep it inline so we don't
             * pollute the shared mRequestListener which is Drawable
             * for the other branches. */
            /* Glide.with(this) ties the request to the fragment's
             * lifecycle so the request manager forwards onStart /
             * onStop to the GifDrawable — without that the drawable
             * never gets the start signal and sits on its first
             * frame. App-context binding (used by the other branches)
             * doesn't matter for static images but actively breaks
             * animation here.
             *
             * resource.start() in onResourceReady is belt-and-braces:
             * if the lifecycle plumbing fails for any reason, the
             * explicit start() guarantees animation. */
            Glide.with(this)
                    .asGif()
                    .load(filePath)
                    .diskCacheStrategy(DiskCacheStrategy.NONE)
                    .listener(new RequestListener<GifDrawable>() {
                        @Override
                        public boolean onLoadFailed(@Nullable GlideException e, Object model,
                                                    @NonNull Target<GifDrawable> target,
                                                    boolean isFirst) {
                            Log.d(TAG, "gif onLoadFailed", e);
                            startPostponedEnterTransition();
                            if (mActivity != null) {
                                Snackbar.make(mActivity.getWindow().getDecorView(),
                                        R.string.error_file, Snackbar.LENGTH_LONG).show();
                            }
                            return false;
                        }

                        @Override
                        public boolean onResourceReady(@NonNull GifDrawable resource, @NonNull Object model,
                                                       Target<GifDrawable> target,
                                                       @NonNull DataSource dataSource, boolean isFirst) {
                            startPostponedEnterTransition();
                            if (!resource.isRunning()) {
                                resource.start();
                            }
                            return false;
                        }
                    })
                    .fallback(R.drawable.ic_baseline_image_24)
                    .error(R.drawable.ic_baseline_image_24)
                    .into(mPhotoView);
        }else if ((FileUriHelper.isSVG(mimeType)  ||
                FileUriHelper.isWEP(mimeType)) && !mDownloadEntity.isFileEncrypted()) {
            RequestOptions options = new RequestOptions().frame(interval)
                    .set(GlideRequestOptions.MIMETYPE, mimeType).set(GlideRequestOptions.FILEPATH, filePath);
            Glide.with(App.getAppContext())
                    .load(filePath)
                    .apply(options)
                    .listener(mRequestListener)
                    .fallback(R.drawable.ic_baseline_image_24)
                    .error(R.drawable.ic_baseline_image_24)
                    .into(mPhotoView);
        } else {
            RequestOptions options =
                    new RequestOptions()
                            .set(GlideRequestOptions.MIMETYPE, mDownloadEntity.getFileMimeType())
                            .set(GlideRequestOptions.FILEPATH, mDownloadEntity.getFilePath())
                            .set(GlideRequestOptions.LENGTH, mDownloadEntity.getFileSize())
                            .set(GlideRequestOptions.FRAME, mDownloadEntity.getThumbnailDuration());

            Glide.with(App.getAppContext()).load(mDownloadEntity)
                    .dontTransform()
                    .override(Target.SIZE_ORIGINAL, Target.SIZE_ORIGINAL)
                    .diskCacheStrategy(DiskCacheStrategy.NONE)
                    .listener(mRequestListener)
                    .apply(options)
                    .into(mPhotoView);
        }

    }

    private final RequestListener<Drawable> mRequestListener = new RequestListener<>() {
        @Override
        public boolean onLoadFailed(@Nullable GlideException e, Object model, @NonNull Target<Drawable> target, boolean isFirstResource) {
            Log.d(TAG, "onLoadFailed", e);
            startPostponedEnterTransition();
            if(mActivity != null){
                Snackbar snackbar = Snackbar.make(mActivity.getWindow().getDecorView(), R.string.error_file, Snackbar.LENGTH_LONG);
                snackbar.show();
            }
            return false;
        }

        @Override
        public boolean onResourceReady(@NonNull Drawable resource, @NonNull Object model, Target<Drawable> target, @NonNull DataSource dataSource, boolean isFirstResource) {
            Log.d(TAG, "onResourceReady");
            startPostponedEnterTransition();
            return false;
        }
    };


}
