package com.solarized.firedown.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.util.AttributeSet;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

public class ProgressOverlayView extends android.view.View {

    private final Paint trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint arcPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF arcRect = new RectF();
    private int progress = 0;
    private boolean indeterminate = false;
    private float indeterminateAngle = 0f;

    public ProgressOverlayView(@NonNull Context context) {
        this(context, null);
    }

    public ProgressOverlayView(@NonNull Context context, @Nullable AttributeSet attrs) {
        this(context, attrs, 0);
    }

    public ProgressOverlayView(@NonNull Context context, @Nullable AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        init();
    }

    private void init() {
        // No background fill — the host card now carries the active
        // 'wash' surface that signals 'live'. Painting an extra coral
        // wash on top double-tinted the grid tile and overpowered the
        // wash. The ring + arc + percent label do all the live-signal
        // work; the surface beneath is whatever the adapter set.

        trackPaint.setStyle(Paint.Style.STROKE);
        trackPaint.setColor(0x40ff716c);
        trackPaint.setStrokeCap(Paint.Cap.ROUND);

        arcPaint.setStyle(Paint.Style.STROKE);
        arcPaint.setColor(0xFFff716c);
        arcPaint.setStrokeCap(Paint.Cap.ROUND);

        textPaint.setColor(0xFFff716c);
        textPaint.setTextAlign(Paint.Align.CENTER);
    }

    public void setProgress(int progress) {
        int clamped = Math.max(0, Math.min(100, progress));
        if (this.progress != clamped) {
            this.progress = clamped;
            invalidate();
        }
    }

    public int getProgress() {
        return progress;
    }



    public void setIndeterminate(boolean indeterminate) {
        if (this.indeterminate != indeterminate) {
            this.indeterminate = indeterminate;
            if (indeterminate) {
                post(this::animateIndeterminate);
            }
            invalidate();
        }
    }

    private void animateIndeterminate() {
        if (!indeterminate) return;
        indeterminateAngle = (indeterminateAngle + 6f) % 360f;
        invalidate();
        postDelayed(this::animateIndeterminate, 16);
    }

    @Override
    protected void onDraw(@NonNull Canvas canvas) {
        super.onDraw(canvas);

        int w = getWidth();
        int h = getHeight();
        if (w == 0 || h == 0) return;

        float cx = w / 2f;
        float cy = h / 2f;
        float radius = Math.min(w, h) * 0.22f;
        float strokeWidth = radius * 0.25f;

        trackPaint.setStrokeWidth(strokeWidth);
        arcPaint.setStrokeWidth(strokeWidth);

        arcRect.set(cx - radius, cy - radius, cx + radius, cy + radius);

        canvas.drawCircle(cx, cy, radius, trackPaint);

        if (indeterminate) {
            canvas.drawArc(arcRect, indeterminateAngle, 90f, false, arcPaint);
        } else {
            float sweep = (progress / 100f) * 360f;
            canvas.drawArc(arcRect, -90, sweep, false, arcPaint);

            textPaint.setTextSize(radius * 0.7f);
            String label = progress + "%";
            float textY = cy - ((textPaint.descent() + textPaint.ascent()) / 2f);
            canvas.drawText(label, cx, textY, textPaint);
        }
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        indeterminate = false;
    }
}