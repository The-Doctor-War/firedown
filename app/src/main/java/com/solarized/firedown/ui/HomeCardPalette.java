package com.solarized.firedown.ui;

import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.AttrRes;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.graphics.ColorUtils;
import androidx.core.widget.ImageViewCompat;

import com.google.android.material.card.MaterialCardView;
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
     * Flips the whole card to this palette's tone — card surface,
     * icon, and text — so the shelf cards read like the
     * active-download / media strips above them (full tinted
     * container, no inner chip). The chip's own background is
     * cleared because a chip-on-tinted-card looks muddy when both
     * share a hue; the icon sits directly on the card surface like
     * the media strip's favicon. Title takes onContainer at full
     * opacity, subtitle the same colour at ~70 % alpha to read as
     * a softer secondary line.
     *
     * <p>{@code mutate()} on the chip drawable guarantees the change
     * is per-view; without it, both cards sharing a drawable resource
     * would smear across each other.</p>
     */
    public void apply(@NonNull MaterialCardView card,
                      @NonNull View chip,
                      @NonNull ImageView icon,
                      @Nullable TextView title,
                      @Nullable TextView subtitle) {
        int container = MaterialColors.getColor(card, containerAttr);
        int onContainer = MaterialColors.getColor(card, onContainerAttr);

        card.setCardBackgroundColor(container);

        Drawable bg = chip.getBackground();
        if (bg != null) {
            bg = bg.mutate();
            if (bg instanceof GradientDrawable) {
                ((GradientDrawable) bg).setColor(Color.TRANSPARENT);
            } else {
                bg.setTint(Color.TRANSPARENT);
            }
            chip.setBackground(bg);
        }
        ImageViewCompat.setImageTintList(icon, ColorStateList.valueOf(onContainer));

        if (title != null) title.setTextColor(onContainer);
        if (subtitle != null) {
            subtitle.setTextColor(ColorUtils.setAlphaComponent(onContainer, 0xB3));
        }
    }
}
