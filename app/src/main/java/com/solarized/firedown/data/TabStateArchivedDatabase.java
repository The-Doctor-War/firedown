package com.solarized.firedown.data;

import androidx.annotation.NonNull;
import androidx.room.Database;
import androidx.room.RoomDatabase;
import androidx.room.migration.Migration;
import androidx.sqlite.db.SupportSQLiteDatabase;

import com.solarized.firedown.data.dao.TabStateArchivedDao;
import com.solarized.firedown.data.entity.TabStateArchivedEntity;

@Database(entities = {TabStateArchivedEntity.class}, version = 2, exportSchema = false)
public abstract class TabStateArchivedDatabase extends RoomDatabase {
    public static final String DATABASE_NAME = "tabstate-db";
    public abstract TabStateArchivedDao tabStateDao();

    /**
     * v1 → v2: add archived_at column. Defaults to 0 for legacy rows so
     * they're excluded from the "archived in the last [interval]" banner
     * count (the query ignores zero values).
     */
    public static final Migration MIGRATION_1_2 = new Migration(1, 2) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase db) {
            db.execSQL("ALTER TABLE tabstate ADD COLUMN archived_at INTEGER NOT NULL DEFAULT 0");
        }
    };
}
