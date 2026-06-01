package com.solarized.firedown.glide;

import android.content.Context;
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

    // Color palette
    private static final int COLOR_BRAND_YELLOW    = 0xFFffa386;
    private static final int COLOR_BRAND_ORANGE    = 0xFFf0716c;

    /**
     * Returns a resolution-independent Drawable that paints a tinted
     * 16:10 card (matching DownloadFragment's grid cell aspect) with
     * the mime icon centred inside, sized from the host's current
     * bounds. No intermediate raster — the icon stays crisp at any
     * view size (grid / list / sw600 / sw720 / player full screen).
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

        /** 16:10, matching DownloadFragment's grid cell card. */
        private static final float CARD_ASPECT = 16f / 10f;

        @Override
        public void draw(@NonNull Canvas canvas) {
            Rect b = getBounds();
            if (b.isEmpty()) return;
            // Paint a centred 16:10 card (matching the downloads grid
            // cell aspect), not the full viewport, so the fallback
            // letterboxes the same way real artwork does under
            // PlayerView's resize_mode="fit".
            int cardWidth, cardHeight;
            if (b.width() / (float) b.height() > CARD_ASPECT) {
                cardHeight = b.height();
                cardWidth = Math.round(cardHeight * CARD_ASPECT);
            } else {
                cardWidth = b.width();
                cardHeight = Math.round(cardWidth / CARD_ASPECT);
            }
            int cardLeft = b.left + (b.width() - cardWidth) / 2;
            int cardTop = b.top + (b.height() - cardHeight) / 2;
            canvas.drawRect(cardLeft, cardTop, cardLeft + cardWidth, cardTop + cardHeight, mBgPaint);
            if (mIcon == null) return;
            int iconSize = (int) (Math.min(cardWidth, cardHeight) * 0.5f);
            int iconLeft = cardLeft + (cardWidth - iconSize) / 2;
            int iconTop = cardTop + (cardHeight - iconSize) / 2;
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