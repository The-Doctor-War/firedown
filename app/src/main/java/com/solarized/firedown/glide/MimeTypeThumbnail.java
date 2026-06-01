package com.solarized.firedown.glide;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import android.graphics.drawable.Drawable;
import androidx.core.content.ContextCompat;

import com.solarized.firedown.utils.FileUriHelper;

public class MimeTypeThumbnail {

    private static final int DEFAULT_SIZE = 256;

    // Color palette
    private static final int COLOR_BRAND_YELLOW    = 0xFFffa386;
    private static final int COLOR_BRAND_ORANGE    = 0xFFf0716c;


    @NonNull
    public static Bitmap generate(
            @NonNull Context context, @NonNull String mimeType, int width, int height
    ) {
        if (width <= 0) width = DEFAULT_SIZE;
        if (height <= 0) height = DEFAULT_SIZE;

        int iconRes = FileUriHelper.getMimeTypeIcon(mimeType);
        int color = getColorForMimeType(mimeType);

        int density = context.getResources().getDisplayMetrics().densityDpi;

        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        bitmap.setDensity(density);
        Canvas canvas = new Canvas(bitmap);

        // Tinted background
        Paint bgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        bgPaint.setColor(color);
        bgPaint.setAlpha(30);
        canvas.drawRect(0, 0, width, height, bgPaint);

        // Draw the icon centered at 50% of the smallest dimension
        Drawable icon = ContextCompat.getDrawable(context, iconRes);
        if (icon != null) {
            int iconSize = (int) (Math.min(width, height) * 0.5f);
            int left = (width - iconSize) / 2;
            int top = (height - iconSize) / 2;

            icon.setBounds(left, top, left + iconSize, top + iconSize);
            icon.setTint(color);
            icon.draw(canvas);
        }

        return bitmap;
    }

    /**
     * Resolution-independent variant of {@link #generate}. Returns a
     * Drawable that paints the tinted background + centred icon into
     * whatever bounds the host gives it, so callers like the player
     * (where the artwork slot's pixel size isn't known until after
     * layout) don't end up baking a 256×180 raster that fitCenters to
     * a thin band in the middle of a portrait viewport. Used as
     * PlayerView's defaultArtwork and as Glide's .error() fallback,
     * both of which size the drawable from view bounds.
     */
    @NonNull
    public static Drawable generateDrawable(@NonNull Context context, @NonNull String mimeType) {
        int color = getColorForMimeType(mimeType);
        Drawable icon = ContextCompat.getDrawable(context, FileUriHelper.getMimeTypeIcon(mimeType));
        if (icon != null) {
            icon = icon.mutate();
            icon.setTint(color);
        }
        return new MimeTypeFallbackDrawable(color, icon);
    }

    private static int getColorForMimeType(@NonNull String mimeType) {
        if (FileUriHelper.isVideo(mimeType))                return COLOR_BRAND_ORANGE;
        if (FileUriHelper.isAudio(mimeType))                return COLOR_BRAND_YELLOW;
        return COLOR_BRAND_ORANGE;
    }

    private static final class MimeTypeFallbackDrawable extends Drawable {

        private final Paint mBgPaint;
        private final Drawable mIcon;

        MimeTypeFallbackDrawable(int color, @Nullable Drawable icon) {
            mBgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            mBgPaint.setColor(color);
            mBgPaint.setAlpha(30);
            mIcon = icon;
        }

        @Override
        public void draw(@NonNull Canvas canvas) {
            Rect b = getBounds();
            if (b.isEmpty()) return;
            // Paint a centred square (the artwork "card"), not the full
            // viewport, so the fallback letterboxes the same way real
            // album art does under PlayerView's resize_mode="fit".
            int side = Math.min(b.width(), b.height());
            int cardLeft = b.left + (b.width() - side) / 2;
            int cardTop = b.top + (b.height() - side) / 2;
            int cardRight = cardLeft + side;
            int cardBottom = cardTop + side;
            canvas.drawRect(cardLeft, cardTop, cardRight, cardBottom, mBgPaint);
            if (mIcon == null) return;
            int iconSize = (int) (side * 0.5f);
            int iconLeft = cardLeft + (side - iconSize) / 2;
            int iconTop = cardTop + (side - iconSize) / 2;
            mIcon.setBounds(iconLeft, iconTop, iconLeft + iconSize, iconTop + iconSize);
            mIcon.draw(canvas);
        }

        @Override
        public void setAlpha(int alpha) {
            mBgPaint.setAlpha(alpha);
            if (mIcon != null) mIcon.setAlpha(alpha);
            invalidateSelf();
        }

        @Override
        public void setColorFilter(@Nullable ColorFilter colorFilter) {
            mBgPaint.setColorFilter(colorFilter);
            if (mIcon != null) mIcon.setColorFilter(colorFilter);
            invalidateSelf();
        }

        @Override
        public int getOpacity() {
            return PixelFormat.TRANSLUCENT;
        }
    }
}