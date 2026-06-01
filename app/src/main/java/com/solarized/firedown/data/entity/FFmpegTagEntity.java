package com.solarized.firedown.data.entity;

import android.os.Parcel;
import android.os.Parcelable;

import androidx.annotation.IntDef;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

/**
 * A single display tag attached to a {@link BrowserDownloadEntity}.
 *
 * <p>Tags represent metadata shown in the browser options UI — quality labels,
 * durations, resolutions. The {@link #type} determines how the adapter renders
 * the tag; {@link #text} is the pre-resolved display value.
 */
public class FFmpegTagEntity implements Parcelable {

    // ── Tag types ────────────────────────────────────────────────────────

    public static final int TYPE_UNKNOWN    = 0;
    public static final int TYPE_DURATION   = 1;  // e.g. "03:45"
    public static final int TYPE_QUALITY    = 2;  // e.g. "1080p", "720p"
    public static final int TYPE_RESOLUTION = 3;  // e.g. "1920x1080" (images)

    @IntDef({TYPE_UNKNOWN, TYPE_DURATION, TYPE_QUALITY, TYPE_RESOLUTION})
    @Retention(RetentionPolicy.SOURCE)
    public @interface TagType {}

    // ── Fields ───────────────────────────────────────────────────────────

    private int uid;
    @Nullable private String text;
    @TagType private int type;

    // ── Constructors ─────────────────────────────────────────────────────

    public FFmpegTagEntity() {
        this.type = TYPE_UNKNOWN;
    }

    /**
     * @deprecated Use {@link #FFmpegTagEntity(int, String, int)} with an explicit
     * {@link TagType}.
     */
    @Deprecated
    public FFmpegTagEntity(int uid, @Nullable String text) {
        this(uid, text, TYPE_UNKNOWN);
    }

    public FFmpegTagEntity(int uid, @Nullable String text, @TagType int type) {
        this.uid = uid;
        this.text = text;
        this.type = type;
    }

    protected FFmpegTagEntity(Parcel in) {
        uid = in.readInt();
        text = in.readString();
        //noinspection WrongConstant — int was written from a @TagType value
        type = in.readInt();
    }

    // ── Parcelable.Creator ───────────────────────────────────────────────

    public static final Creator<FFmpegTagEntity> CREATOR = new Creator<>() {
        @Override
        public FFmpegTagEntity createFromParcel(Parcel in) {
            return new FFmpegTagEntity(in);
        }

        @Override
        public FFmpegTagEntity[] newArray(int size) {
            return new FFmpegTagEntity[size];
        }
    };

    // ── Getters / Setters ────────────────────────────────────────────────

    public int getUid() {
        return uid;
    }

    public void setUid(int uid) {
        this.uid = uid;
    }

    @Nullable
    public String getText() {
        return text;
    }

    public void setText(@Nullable String text) {
        this.text = text;
    }

    @TagType
    public int getType() {
        return type;
    }

    public void setType(@TagType int type) {
        this.type = type;
    }

    // ── Parcelable ───────────────────────────────────────────────────────

    @Override
    public int describeContents() {
        return 0;
    }

    @Override
    public void writeToParcel(@NonNull Parcel dest, int flags) {
        dest.writeInt(uid);
        dest.writeString(text);
        dest.writeInt(type);
    }
}