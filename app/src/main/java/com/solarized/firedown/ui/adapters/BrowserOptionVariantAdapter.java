package com.solarized.firedown.ui.adapters;

import android.content.Context;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.radiobutton.MaterialRadioButton;
import com.solarized.firedown.R;
import com.solarized.firedown.ffmpegutils.FFmpegEntity;
import com.solarized.firedown.ffmpegutils.FFmpegUtils;
import com.solarized.firedown.ui.OnItemClickListener;

import java.util.ArrayList;
import java.util.List;


public class BrowserOptionVariantAdapter extends RecyclerView.Adapter<BrowserOptionVariantAdapter.VariantHolder> {

    private static final String PAYLOAD_SELECTION = "selection";

    private final ArrayList<FFmpegEntity> mVariants;
    private final OnItemClickListener mOnItemClickListener;
    private int mSelectedPosition;


    public BrowserOptionVariantAdapter(ArrayList<FFmpegEntity> variants, OnItemClickListener onItemClickListener) {
        mOnItemClickListener = onItemClickListener;
        variants.sort(FFmpegUtils.FFmpegEntityComparator);
        mVariants = new ArrayList<>(variants);
        mSelectedPosition = 0;
        for (int i = 0; i < mVariants.size(); i++) {
            Log.d("VariantAdapter", "pos=" + i + " info=" + mVariants.get(i).getInfo()
                    + " videoNum=" + mVariants.get(i).getVideoStreamNumber()
                    + " audioNum=" + mVariants.get(i).getAudioStreamNumber());
        }
    }

    @NonNull
    @Override
    public VariantHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext())
                .inflate(R.layout.fragment_dialog_browser_options_item_variant, parent, false);
        return new VariantHolder(view, mOnItemClickListener);
    }

    @Override
    public void onBindViewHolder(@NonNull VariantHolder holder, int position) {
        FFmpegEntity entity = mVariants.get(position);
        boolean selected = mSelectedPosition == position;

        holder.bindTitle(entity);
        holder.bindMeta(entity);
        holder.bindSelection(selected);
    }

    @Override
    public void onBindViewHolder(@NonNull VariantHolder holder, int position, @NonNull List<Object> payloads) {
        if (payloads.isEmpty()) {
            onBindViewHolder(holder, position);
            return;
        }
        for (Object payload : payloads) {
            if (PAYLOAD_SELECTION.equals(payload)) {
                holder.bindSelection(mSelectedPosition == position);
            }
        }
    }

    @Override
    public int getItemCount() {
        return mVariants.size();
    }


    public FFmpegEntity getSelectedStream() {
        return mVariants.get(mSelectedPosition);
    }

    public int getSelectedPosition() {
        return mSelectedPosition;
    }


    public void setSelected(int position) {
        if (position == mSelectedPosition) return;
        int previous = mSelectedPosition;
        mSelectedPosition = position;
        notifyItemChanged(previous, PAYLOAD_SELECTION);
        notifyItemChanged(position, PAYLOAD_SELECTION);
    }


    public static class VariantHolder extends RecyclerView.ViewHolder implements View.OnClickListener {

        private final OnItemClickListener mOnItemClickListener;
        private final MaterialRadioButton radioButton;
        private final TextView streamTitle;
        private final TextView streamInfo;

        VariantHolder(View view, OnItemClickListener onItemClickListener) {
            super(view);
            mOnItemClickListener = onItemClickListener;
            View item = view.findViewById(R.id.file_variants_item);
            radioButton = view.findViewById(R.id.radio_button);
            streamTitle = view.findViewById(R.id.stream_title);
            streamInfo = view.findViewById(R.id.stream_info);
            item.setOnClickListener(this);
        }


        void bindTitle(FFmpegEntity entity) {
            String description = entity.getStreamDescription();
            if ((description == null || description.isEmpty()) && entity.isAudioOnly()) {
                description = itemView.getContext().getString(R.string.stream_audio_only_title);
            }
            streamTitle.setText(description != null ? description : "");
        }


        /**
         * Single meta line: "&lt;stream type&gt; · &lt;codec&gt;". Replaces the
         * old loud filled chip + separate codec text — the stream type now
         * reads as quiet metadata, consistent with the captions rows below.
         * Joins with " · " only when both parts are present.
         */
        void bindMeta(FFmpegEntity entity) {
            Context context = itemView.getContext();
            int typeRes = entity.isAudioOnly()
                    ? R.string.stream_type_audio
                    : entity.isVideoOnly()
                        ? R.string.stream_type_video
                        : R.string.stream_type_muxed;
            String type = context.getString(typeRes);
            String codec = entity.getCodecLabel();

            String meta = (codec != null && !codec.isEmpty())
                    ? type + " · " + codec
                    : type;
            streamInfo.setText(meta);
        }


        void bindSelection(boolean selected) {
            radioButton.setChecked(selected);
            itemView.setActivated(selected);
        }


        @Override
        public void onClick(View v) {
            int position = getAbsoluteAdapterPosition();
            if (position != RecyclerView.NO_POSITION && mOnItemClickListener != null) {
                mOnItemClickListener.onItemClick(position, v.getId());
            }
        }
    }
}