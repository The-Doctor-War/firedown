package com.solarized.firedown.ui;

import android.content.Context;
import android.util.AttributeSet;

import androidx.appcompat.widget.AppCompatImageView;

/**
 * ImageView that measures itself to a fixed width/height aspect when one
 * is set, fitting the ratio within whatever bounds the parent gives it.
 *
 * <p>Sized lives in the view rather than at the call site so the shared
 * element transition picks up the destination bounds during measure —
 * setting layout params from a fragment runs too late to affect the
 * postponed transition's captured target.</p>
 *
 * <p>Aspect of {@code 0f} (the default) leaves the view as a normal
 * ImageView — measure spec passes straight through to super, so callers
 * that want match_parent for a different mime type just don't set it.</p>
 */
public class AspectRatioImageView extends AppCompatImageView {

    /** width / height. 0 = no constraint. */
    private float mAspectRatio = 0f;

    public AspectRatioImageView(Context context) {
        super(context);
    }

    public AspectRatioImageView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public AspectRatioImageView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    /** Set width/height ratio. 0 to clear and behave as a normal ImageView. */
    public void setAspectRatio(float ratio) {
        if (mAspectRatio == ratio) return;
        mAspectRatio = ratio;
        requestLayout();
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        if (mAspectRatio <= 0f) {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec);
            return;
        }
        int wSize = MeasureSpec.getSize(widthMeasureSpec);
        int hSize = MeasureSpec.getSize(heightMeasureSpec);
        int width, height;
        // Fit the ratio inside the available bounds: whichever axis is
        // tighter at this aspect wins.
        if (wSize <= hSize * mAspectRatio) {
            width = wSize;
            height = (int) (wSize / mAspectRatio);
        } else {
            height = hSize;
            width = (int) (hSize * mAspectRatio);
        }
        setMeasuredDimension(width, height);
    }
}
