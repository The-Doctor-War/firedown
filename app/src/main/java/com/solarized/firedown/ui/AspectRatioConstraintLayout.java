package com.solarized.firedown.ui;

import android.content.Context;
import android.content.res.TypedArray;
import android.util.AttributeSet;
import android.view.View;

import androidx.constraintlayout.widget.ConstraintLayout;

import com.solarized.firedown.R;

/**
 * ConstraintLayout that measures with a fixed width:height ratio
 * derived from its width measure spec, independent of child content.
 *
 * <p>Used as the root of tab grid items. The previous root was a plain
 * {@link ConstraintLayout} with {@code layout_height="wrap_content"}
 * wrapping a {@code MaterialCardView} with
 * {@code layout_constraintDimensionRatio}. When a tab thumbnail finished
 * loading after the page was already on-screen, the
 * {@code ShapeableImageView} inside the card called {@code requestLayout}
 * to re-evaluate its bounds; the wrap_content root would then re-measure
 * the chain, and the resulting (sometimes briefly different) item
 * height let {@code GridLayoutManager} re-anchor the grid — the visible
 * "active tab slides down" shift the user reports a few hundred ms
 * after the page appears.</p>
 *
 * <p>By overriding {@code onMeasure} to clamp the height to
 * {@code width × ratio} with an {@code EXACTLY} spec, we make the item
 * height a pure function of width. Anything inside the card can call
 * {@code requestLayout}; the outer height we report to the RecyclerView
 * never changes.</p>
 *
 * <p>Read the ratio from the {@code aspectRatio} XML attribute; e.g.
 * {@code app:aspectRatio="0.75"} for 3:4 (height = width × 4/3, so
 * width/height = 3/4 = 0.75).</p>
 */
public class AspectRatioConstraintLayout extends ConstraintLayout {

    private float mAspectRatio = 0f;

    public AspectRatioConstraintLayout(Context context) {
        this(context, null);
    }

    public AspectRatioConstraintLayout(Context context, AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public AspectRatioConstraintLayout(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        if (attrs != null) {
            TypedArray a = context.obtainStyledAttributes(
                    attrs, R.styleable.AspectRatioConstraintLayout, defStyleAttr, 0);
            mAspectRatio = a.getFloat(R.styleable.AspectRatioConstraintLayout_aspectRatio, 0f);
            a.recycle();
        }
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        if (mAspectRatio <= 0f) {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec);
            return;
        }
        int width = View.MeasureSpec.getSize(widthMeasureSpec);
        int height = (int) (width / mAspectRatio);
        super.onMeasure(
                widthMeasureSpec,
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY));
    }
}
