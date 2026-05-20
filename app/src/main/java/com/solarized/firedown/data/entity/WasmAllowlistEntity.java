package com.solarized.firedown.data.entity;

import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

@Entity(tableName = "wasm_allowlist")
public class WasmAllowlistEntity {

    @PrimaryKey
    public int uid;

    @ColumnInfo(name = "origin")
    private String mOrigin;

    @ColumnInfo(name = "date")
    private long mDate;

    public int getId() {
        return uid;
    }

    public void setId(int id) {
        this.uid = id;
    }

    public String getOrigin() {
        return mOrigin;
    }

    public void setOrigin(String origin) {
        this.mOrigin = origin;
    }

    public long getDate() {
        return mDate;
    }

    public void setDate(long date) {
        this.mDate = date;
    }
}
