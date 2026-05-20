package com.solarized.firedown.ui;

import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.content.res.Resources;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.annotation.ColorInt;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.StringRes;
import androidx.core.graphics.ColorUtils;
import androidx.core.widget.ImageViewCompat;

import com.google.android.material.card.MaterialCardView;
import com.solarized.firedown.R;

import java.util.Arrays;
import java.util.List;

/**
 * Packaged style for the Downloads + Safe Folder shelf cards on the
 * home page. Five variants — matches the mockups in
 * branding/layouts/shelfcardsvariants.html — let the user pick a
 * coherent look that applies to both cards at once, rather than
 * tinkering with per-card colours.
 *
 * <p>Colours are raw hex (not theme attrs) because most variants are
 * deliberately off-palette: pale washes, full-saturation brand
 * surfaces, or always-dark even in light theme. Encoding them as
 * theme tokens would mean adding light + dark colour resources for
 * each variant and still ending up with the same constants, so we
 * just keep them inline.</p>
 *
 * <p>Active-download and playing-media cards are deliberately
 * untouched — they carry their own brand colours so the home page
 * always has two 'live' anchors regardless of the user's shelf
 * choice.</p>
 */
public final class HomeCardStyle {

    /** Resolved colour set for one card under one theme mode. */
    public static final class CardLook {
        @ColorInt public final int bg;
        @ColorInt public final int fg;
        /** null = no chip background (icon sits directly on the card surface). */
        @Nullable @ColorInt public final Integer chipBg;
        @ColorInt public final int iconColor;

        public CardLook(@ColorInt int bg, @ColorInt int fg,
                        @Nullable @ColorInt Integer chipBg,
                        @ColorInt int iconColor) {
            this.bg = bg;
            this.fg = fg;
            this.chipBg = chipBg;
            this.iconColor = iconColor;
        }
    }

    @NonNull public final String key;
    @StringRes public final int nameRes;
    @NonNull private final CardLook downloadsLight;
    @NonNull private final CardLook downloadsDark;
    @NonNull private final CardLook vaultLight;
    @NonNull private final CardLook vaultDark;

    private HomeCardStyle(@NonNull String key, @StringRes int nameRes,
                          @NonNull CardLook dl, @NonNull CardLook dd,
                          @NonNull CardLook vl, @NonNull CardLook vd) {
        this.key = key;
        this.nameRes = nameRes;
        this.downloadsLight = dl;
        this.downloadsDark = dd;
        this.vaultLight = vl;
        this.vaultDark = vd;
    }

    @NonNull
    public CardLook downloads(boolean night) { return night ? downloadsDark : downloadsLight; }

    @NonNull
    public CardLook vault(boolean night) { return night ? vaultDark : vaultLight; }

    /** 0 — current shelf look (neutral surface + tonal chip). */
    public static final HomeCardStyle CURRENT = new HomeCardStyle("current",
            R.string.home_card_style_current,
            new CardLook(0xFFEFEDF0, 0xFF1B1B1E, 0xFFFF857F, 0xFF460005),
            new CardLook(0xFF1F1F22, 0xFFE4E2E5, 0xFFF66A66, 0xFF0F0000),
            new CardLook(0xFFEFEDF0, 0xFF1B1B1E, 0xFFC8417B, 0xFFFFFFFF),
            new CardLook(0xFF1F1F22, 0xFFE4E2E5, 0xFFC8417B, 0xFFFFFFFF));

    /** 1 — pale-tinted surface (light) / deep warm surface (dark), no chip. */
    public static final HomeCardStyle TINTED_NO_CHIP = new HomeCardStyle("tinted_no_chip",
            R.string.home_card_style_tinted_no_chip,
            new CardLook(0xFFFFE6E0, 0xFF5C1313, null, 0xFFB11030),
            new CardLook(0xFF3A1F1C, 0xFFF4DDDB, null, 0xFFF66A66),
            new CardLook(0xFFFBE2EC, 0xFF5C1B3F, null, 0xFF8C1F49),
            new CardLook(0xFF3A1A28, 0xFFF4DDDB, null, 0xFFFFB0C9));

    /** 2 — tinted surface + chip kept. */
    public static final HomeCardStyle TINTED_WITH_CHIP = new HomeCardStyle("tinted_with_chip",
            R.string.home_card_style_tinted_with_chip,
            new CardLook(0xFFFFE6E0, 0xFF5C1313, 0xFFFF857F, 0xFF460005),
            new CardLook(0xFF3A1F1C, 0xFFF4DDDB, 0xFFF66A66, 0xFF0F0000),
            new CardLook(0xFFFBE2EC, 0xFF5C1B3F, 0xFFC8417B, 0xFFFFFFFF),
            new CardLook(0xFF3A1A28, 0xFFF4DDDB, 0xFFC8417B, 0xFFFFFFFF));

    /** 3 — full-saturation brand surface (matches the live cards). */
    public static final HomeCardStyle FILLED_BRAND = new HomeCardStyle("filled_brand",
            R.string.home_card_style_filled_brand,
            new CardLook(0xFFFF857F, 0xFF460005, null, 0xFF460005),
            new CardLook(0xFFF66A66, 0xFF0F0000, null, 0xFF0F0000),
            new CardLook(0xFFC8417B, 0xFFFFFFFF, null, 0xFFFFFFFF),
            new CardLook(0xFFC8417B, 0xFFFFFFFF, null, 0xFFFFFFFF));

    /** 4 — dark warm surface in both modes (screenshot literal). */
    public static final HomeCardStyle ALWAYS_DARK = new HomeCardStyle("always_dark",
            R.string.home_card_style_always_dark,
            new CardLook(0xFF3A1F1C, 0xFFF4DDDB, null, 0xFFFF857F),
            new CardLook(0xFF3A1F1C, 0xFFF4DDDB, null, 0xFFF66A66),
            new CardLook(0xFF3A1A28, 0xFFF4DDDB, null, 0xFFFFB0C9),
            new CardLook(0xFF3A1A28, 0xFFF4DDDB, null, 0xFFFFB0C9));

    public static final List<HomeCardStyle> ALL =
            Arrays.asList(CURRENT, TINTED_NO_CHIP, TINTED_WITH_CHIP, FILLED_BRAND, ALWAYS_DARK);

    @NonNull
    public static HomeCardStyle fromKey(@Nullable String key, @NonNull HomeCardStyle fallback) {
        if (key == null) return fallback;
        for (HomeCardStyle s : ALL) if (s.key.equals(key)) return s;
        return fallback;
    }

    public static boolean isNightMode(@NonNull Resources resources) {
        int mode = resources.getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return mode == Configuration.UI_MODE_NIGHT_YES;
    }

    /**
     * Paints one card with the given look — card surface, chip
     * background (or transparent), icon tint, title and subtitle
     * colours all flip together. {@code mutate()} on the chip
     * drawable scopes the colour change to this view instance so
     * cards sharing a drawable resource don't smear into each other.
     */
    public static void applyToCard(@NonNull MaterialCardView card,
                                   @Nullable View chip,
                                   @Nullable ImageView icon,
                                   @Nullable TextView title,
                                   @Nullable TextView subtitle,
                                   @NonNull CardLook look) {
        card.setCardBackgroundColor(look.bg);

        if (chip != null) {
            Drawable bg = chip.getBackground();
            if (bg != null) {
                bg = bg.mutate();
                int chipColor = look.chipBg == null ? Color.TRANSPARENT : look.chipBg;
                if (bg instanceof GradientDrawable) {
                    ((GradientDrawable) bg).setColor(chipColor);
                } else {
                    bg.setTint(chipColor);
                }
                chip.setBackground(bg);
            }
        }
        if (icon != null) {
            ImageViewCompat.setImageTintList(icon, ColorStateList.valueOf(look.iconColor));
        }
        if (title != null) title.setTextColor(look.fg);
        if (subtitle != null) {
            subtitle.setTextColor(ColorUtils.setAlphaComponent(look.fg, 0xB3));
        }
    }
}
