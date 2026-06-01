package com.solarized.firedown.ui.adapters;

import android.text.TextUtils;
import android.util.SparseBooleanArray;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.checkbox.MaterialCheckBox;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.BrowserDownloadEntity;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Multi-select list of caption tracks for one video, shown inside the
 * variant picker below the quality variants. Each row toggles inclusion via
 * its checkbox; the parent fragment reads {@link #getSelected()} when the
 * user taps Download.
 *
 * <p>Selection is held in a {@link SparseBooleanArray} keyed by position
 * — the adapter list is fixed for the lifetime of the picker so positional
 * keys are stable.</p>
 */
public class BrowserOptionCaptionAdapter
        extends RecyclerView.Adapter<BrowserOptionCaptionAdapter.ViewHolder> {

    /** Pattern stripping the " [lang]" suffix appended by GeckoInspectTask
     *  so the row label shows the human-readable display name only.
     *  Greedy at the tail end of the string, matches "[en]", "[es-419]",
     *  "[en-auto]" — the same shapes we emit. */
    private static final Pattern LANG_SUFFIX = Pattern.compile("\\s*\\[[A-Za-z0-9-]+]\\s*$");

    private final List<BrowserDownloadEntity> mItems;
    private final SparseBooleanArray mSelected = new SparseBooleanArray();

    public BrowserOptionCaptionAdapter(@NonNull List<BrowserDownloadEntity> items) {
        this.mItems = items;
    }

    /** Preselect the rows whose language code matches any in the given set
     *  (e.g. the user's locale + English). No-op if the set is empty. */
    public void preselectLanguages(@NonNull List<String> bcp47Codes) {
        if (bcp47Codes.isEmpty()) return;
        for (int i = 0; i < mItems.size(); i++) {
            String code = extractLangCode(mItems.get(i));
            if (code != null && bcp47Codes.contains(code)) {
                mSelected.put(i, true);
            }
        }
    }

    /** Entities the user has ticked. Order matches adapter position. */
    @NonNull
    public List<BrowserDownloadEntity> getSelected() {
        List<BrowserDownloadEntity> out = new ArrayList<>();
        for (int i = 0; i < mItems.size(); i++) {
            if (mSelected.get(i)) out.add(mItems.get(i));
        }
        return out;
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View v = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.fragment_dialog_browser_options_caption_item, parent, false);
        return new ViewHolder(v);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        BrowserDownloadEntity entity = mItems.get(position);
        String langCode = extractLangCode(entity);
        boolean isAuto = langCode != null && langCode.endsWith("-auto");
        String displayCode = isAuto ? langCode.substring(0, langCode.length() - 5) : langCode;

        // Row label: full localised language name when we can resolve the
        // BCP-47 code, otherwise the code itself. Falls back to the entity
        // filename (lang stripped) if no code is recoverable.
        String label = null;
        if (!TextUtils.isEmpty(displayCode)) {
            label = new Locale(displayCode).getDisplayName();
        }
        if (TextUtils.isEmpty(label)) {
            label = stripLangSuffix(entity.getFileName());
        }
        holder.label.setText(label);

        // Meta line: BCP-47 code + an "(auto)" hint when the parser flagged
        // it as ASR. Helps the user tell manual EN from generated EN.
        StringBuilder meta = new StringBuilder();
        if (!TextUtils.isEmpty(displayCode)) {
            meta.append(displayCode);
        }
        if (isAuto) {
            if (meta.length() > 0) meta.append(" · ");
            meta.append(holder.itemView.getResources().getString(R.string.caption_auto_label));
        }
        if (meta.length() == 0) {
            holder.meta.setVisibility(View.GONE);
        } else {
            holder.meta.setVisibility(View.VISIBLE);
            holder.meta.setText(meta.toString());
        }

        holder.checkbox.setChecked(mSelected.get(position));
        holder.itemView.setOnClickListener(v -> {
            int p = holder.getAdapterPosition();
            if (p == RecyclerView.NO_POSITION) return;
            boolean now = !mSelected.get(p);
            mSelected.put(p, now);
            holder.checkbox.setChecked(now);
        });
    }

    @Override
    public int getItemCount() {
        return mItems.size();
    }

    /** Pulls the BCP-47 tag out of the filename suffix the parser appended
     *  ("Title [en-auto].srt" → "en-auto"). Returns null when absent so the
     *  caller can fall back to the raw filename. */
    private static String extractLangCode(BrowserDownloadEntity entity) {
        String name = entity.getFileName();
        if (TextUtils.isEmpty(name)) return null;
        Matcher m = Pattern.compile("\\[([A-Za-z0-9-]+)]").matcher(name);
        String last = null;
        while (m.find()) last = m.group(1);
        return last;
    }

    private static String stripLangSuffix(String name) {
        if (TextUtils.isEmpty(name)) return name;
        return LANG_SUFFIX.matcher(name).replaceFirst("");
    }

    static final class ViewHolder extends RecyclerView.ViewHolder {
        final MaterialCheckBox checkbox;
        final TextView label;
        final TextView meta;

        ViewHolder(@NonNull View itemView) {
            super(itemView);
            checkbox = itemView.findViewById(R.id.caption_checkbox);
            label = itemView.findViewById(R.id.caption_label);
            meta = itemView.findViewById(R.id.caption_meta);
        }
    }
}
