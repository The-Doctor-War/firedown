package com.solarized.firedown.ui;

import android.content.res.ColorStateList;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.ImageView;

import androidx.annotation.AttrRes;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.widget.ImageViewCompat;

import com.google.android.material.color.MaterialColors;

/**
 * Per-card chip palettes for the home shelf cards (Downloads, Safe
 * Folder). Each entry maps to a pair of theme attrs — container colour
 * for the chip background, on-container colour for the icon + label —
 * so light / dark variants and on-colour contrast come 'for free' from
 * the M3 token set already defined in colors.xml. No new colours are
 * introduced; we just let the user pick which of the existing tonal
 * containers fronts each card.
 *
 * <p>Spike scope: kept to the four tones already in the theme. A free
 * colour picker would need contrast checks + accessibility review and
 * is out of scope for the experiment.</p>
 */
public enum HomeCardPalette {

    CORAL(
            "coral",
            com.google.android.material.R.attr.colorPrimaryContainer,
            com.google.android.material.R.attr.colorOnPrimaryContainer),

    PEACH(
            "peach",
            com.google.android.material.R.attr.colorSecondaryContainer,
            com.google.android.material.R.attr.colorOnSecondaryContainer),

    RASPBERRY(
            "raspberry",
            com.google.android.material.R.attr.colorTertiaryContainer,
            com.google.android.material.R.attr.colorOnTertiaryContainer),

    NEUTRAL(
            "neutral",
            com.google.android.material.R.attr.colorSurfaceContainerHighest,
            com.google.android.material.R.attr.colorOnSurfaceVariant);

    @NonNull public final String key;
    @AttrRes public final int containerAttr;
    @AttrRes public final int onContainerAttr;

    HomeCardPalette(@NonNull String key,
                    @AttrRes int containerAttr,
                    @AttrRes int onContainerAttr) {
        this.key = key;
        this.containerAttr = containerAttr;
        this.onContainerAttr = onContainerAttr;
    }

    @NonNull
    public static HomeCardPalette fromKey(@Nullable String key,
                                          @NonNull HomeCardPalette fallback) {
        if (key == null) return fallback;
        for (HomeCardPalette p : values()) {
            if (p.key.equals(key)) return p;
        }
        return fallback;
    }

    /**
     * Re-tints the chip background and icon to this palette. The chip
     * is expected to carry one of the {@code bg_icon_container_*}
     * drawables — a shape with a solid fill — so a {@code mutate() +
     * setColor()} on the {@link GradientDrawable} swaps the colour
     * without leaking the change to other views sharing the resource.
     */
    public void apply(@NonNull View chip, @NonNull ImageView icon) {
        int container = MaterialColors.getColor(chip, containerAttr);
        int onContainer = MaterialColors.getColor(chip, onContainerAttr);

        Drawable bg = chip.getBackground();
        if (bg != null) {
            bg = bg.mutate();
            if (bg instanceof GradientDrawable) {
                ((GradientDrawable) bg).setColor(container);
            } else {
                bg.setTint(container);
            }
            chip.setBackground(bg);
        }
        ImageViewCompat.setImageTintList(icon, ColorStateList.valueOf(onContainer));
    }
}
