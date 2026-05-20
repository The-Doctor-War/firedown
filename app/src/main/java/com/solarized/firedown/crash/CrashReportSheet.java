package com.solarized.firedown.crash;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.format.DateUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.FragmentManager;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.google.android.material.bottomsheet.BottomSheetBehavior;
import com.google.android.material.bottomsheet.BottomSheetDialogFragment;
import com.google.android.material.button.MaterialButton;
import com.solarized.firedown.R;

import java.io.File;
import java.util.List;

/**
 * Bottom sheet that surfaces a captured crash on the next launch.
 * Single UI for both crash sources — the {@link CrashReport} carries
 * its own type and origin, the layout doesn't care whether it came
 * from a Java exception or a Gecko child-process death.
 *
 * <p>Three actions:
 * <ul>
 *   <li><b>Report on GitHub</b> — opens the pre-filled new-issue URL
 *       in the system browser; the URL body is capped at ~6KB, so we
 *       also copy the full trace to the clipboard as a paste-in
 *       fallback for long traces.</li>
 *   <li><b>Copy</b> — clipboard only, for users who want to file the
 *       report somewhere other than GitHub (issue tracker email, etc).</li>
 *   <li><b>Dismiss</b> — deletes the file without sending anything.</li>
 * </ul>
 *
 * <p>If there are multiple pending crashes we show the newest one and
 * sweep the rest on report/dismiss — saves the user from a stack of
 * dialogs and the same crash is likely to repeat anyway.</p>
 */
public class CrashReportSheet extends BottomSheetDialogFragment {

    private static final String TAG = "CrashReportSheet";

    @Nullable
    private CrashReport mReport;
    @NonNull
    private List<File> mPending = java.util.Collections.emptyList();

    /**
     * Shows the sheet if at least one pending report exists. Safe to
     * call from {@code onStart} on every fragment activation —
     * idempotent via the {@code findFragmentByTag} check, and after
     * the user actions the sheet the pending files are deleted so
     * subsequent calls bail at the {@code pending.isEmpty()} guard.
     * A Gecko child crash that lands after the user dismisses still
     * surfaces on the next {@code onStart} because we don't rely on
     * a per-process "shown once" flag.
     */
    public static void showIfPending(@NonNull Context context,
                                     @NonNull FragmentManager fm) {
        List<File> pending = CrashStorage.listPending(context);
        android.util.Log.i(TAG, "showIfPending: pending=" + pending.size()
                + " stateSaved=" + fm.isStateSaved()
                + " alreadyShown=" + (fm.findFragmentByTag(TAG) != null));
        if (pending.isEmpty()) return;
        if (fm.findFragmentByTag(TAG) != null) return;
        if (fm.isStateSaved()) return;
        new CrashReportSheet().show(fm, TAG);
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater,
                             @Nullable ViewGroup container,
                             @Nullable Bundle savedInstanceState) {
        mPending = CrashStorage.listPending(requireContext());
        if (mPending.isEmpty()) {
            dismissAllowingStateLoss();
            return null;
        }
        mReport = CrashStorage.read(mPending.get(0));
        if (mReport == null) {
            // Corrupt file — drop it and bail.
            CrashStorage.delete(mPending.get(0));
            dismissAllowingStateLoss();
            return null;
        }
        return inflater.inflate(R.layout.fragment_dialog_crash_report, container, false);
    }

    @Override
    public void onViewCreated(@NonNull View view, @Nullable Bundle savedInstanceState) {
        super.onViewCreated(view, savedInstanceState);
        if (mReport == null) return;

        // System bar / gesture handle insets — without this the
        // action row at the bottom of the sheet sits under the nav
        // bar and the buttons aren't tappable. Mirrors the inset
        // handling BaseBottomSheetDialogFragment applies to its
        // sheets.
        ViewCompat.setOnApplyWindowInsetsListener(view, (v, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout());
            v.setPadding(insets.left, 0, insets.right, insets.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        TextView subtitle = view.findViewById(R.id.crash_subtitle);
        TextView trace = view.findViewById(R.id.crash_trace);

        CharSequence when = DateUtils.getRelativeTimeSpanString(
                mReport.timestamp, System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS);
        String subtitleText = when + " · v" + mReport.versionName
                + " · " + mReport.type + "/" + mReport.origin;
        if (mPending.size() > 1) {
            subtitleText += "  (+" + (mPending.size() - 1) + " more)";
        }
        subtitle.setText(subtitleText);
        trace.setText(mReport.trace);

        MaterialButton report = view.findViewById(R.id.crash_report);
        MaterialButton copy = view.findViewById(R.id.crash_copy);
        MaterialButton dismiss = view.findViewById(R.id.crash_dismiss);

        report.setOnClickListener(v -> onReport());
        copy.setOnClickListener(v -> onCopy());
        dismiss.setOnClickListener(v -> onDismiss());
    }

    private void onReport() {
        if (mReport == null) return;
        // Stash the full trace on the clipboard so the user can paste
        // it into the issue body if GitHub's URL-length cap truncated
        // the version we sent inline.
        copyToClipboard(CrashReportUrlBuilder.fullText(mReport));

        Uri url = CrashReportUrlBuilder.build(mReport);
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, url);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Throwable t) {
            Toast.makeText(requireContext(),
                    R.string.crash_sheet_open_failed, Toast.LENGTH_LONG).show();
            return;
        }
        sweepAndDismiss();
    }

    private void onCopy() {
        if (mReport == null) return;
        copyToClipboard(CrashReportUrlBuilder.fullText(mReport));
        Toast.makeText(requireContext(),
                R.string.crash_sheet_copied, Toast.LENGTH_SHORT).show();
        sweepAndDismiss();
    }

    private void onDismiss() {
        sweepAndDismiss();
    }

    private void sweepAndDismiss() {
        // File cleanup lives in onDismiss so swipe-down / back also
        // sweep — see the override above.
        dismissAllowingStateLoss();
    }

    @Override
    public void onStart() {
        super.onStart();
        // Match BaseBottomSheetDialogFragment's sizing pattern:
        // skip the half-collapsed peek state (this sheet's content is
        // small enough that the peek would clip the action row), cap
        // width at R.dimen.bottom_sheet_max_width (sentinel 0 in
        // values/dimens.xml clears the cap for portrait phones; the
        // landscape / tablet override puts a real cap), and cap
        // height at R.dimen.bottom_sheet_max_height.
        View parent = getView() != null ? (View) getView().getParent() : null;
        if (parent == null) return;
        BottomSheetBehavior<View> behavior = BottomSheetBehavior.from(parent);
        behavior.setSkipCollapsed(true);
        behavior.setState(BottomSheetBehavior.STATE_EXPANDED);
        int maxWidthPx = getResources().getDimensionPixelSize(R.dimen.bottom_sheet_max_width);
        behavior.setMaxWidth(maxWidthPx > 0 ? maxWidthPx : -1);
        int maxHeightPx = getResources().getDimensionPixelSize(R.dimen.bottom_sheet_max_height);
        behavior.setMaxHeight(maxHeightPx > 0 ? maxHeightPx : -1);
        parent.requestLayout();
    }

    /**
     * Any dismissal — Report/Copy/Dismiss button, swipe-down, back
     * press, tap outside — sweeps the pending files. The "show me
     * again next time" model would require an explicit "Later"
     * button, which we don't have; treating every exit as final
     * matches what users mean when they dismiss a crash dialog
     * (either they reported or they don't want to). Without this
     * override, swipe-down/back left the files on disk and the
     * sheet popped on every subsequent activity start.
     */
    @Override
    public void onDismiss(@NonNull DialogInterface dialog) {
        for (File f : mPending) CrashStorage.delete(f);
        super.onDismiss(dialog);
    }

    private void copyToClipboard(@NonNull String text) {
        ClipboardManager cm = (ClipboardManager) requireContext()
                .getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(ClipData.newPlainText("Firedown crash", text));
        }
    }
}
