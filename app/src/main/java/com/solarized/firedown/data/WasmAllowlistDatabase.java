package com.solarized.firedown.data;

import androidx.annotation.VisibleForTesting;
import androidx.room.Database;
import androidx.room.RoomDatabase;

import com.solarized.firedown.data.dao.WasmAllowlistDao;
import com.solarized.firedown.data.entity.WasmAllowlistEntity;

@Database(entities = {WasmAllowlistEntity.class}, version = 1, exportSchema = false)
public abstract class WasmAllowlistDatabase extends RoomDatabase {

    @VisibleForTesting
    public static final String DATABASE_NAME = "wasm-allowlist-db";

    public abstract WasmAllowlistDao wasmAllowlistDao();
}
