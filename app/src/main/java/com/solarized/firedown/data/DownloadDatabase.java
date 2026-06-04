package com.solarized.firedown.data;

import androidx.annotation.NonNull;
import androidx.room.Database;
import androidx.room.DeleteColumn;
import androidx.room.RoomDatabase;
import androidx.room.migration.AutoMigrationSpec;
import androidx.room.migration.Migration;
import androidx.sqlite.db.SupportSQLiteDatabase;

import com.solarized.firedown.data.dao.DownloadDao;
import com.solarized.firedown.data.entity.DownloadEntity;

@Database(entities = {DownloadEntity.class}, version = 12, exportSchema = true)
public abstract class DownloadDatabase extends RoomDatabase {

    public static final String DATABASE_NAME = "download-db";

    @DeleteColumn.Entries({
            @DeleteColumn(tableName = "download", columnName = "file_filtered"),
            @DeleteColumn(tableName = "download", columnName = "file_storage_path"),
            @DeleteColumn(tableName = "download", columnName = "file_referer_url"),
            @DeleteColumn(tableName = "download", columnName = "file_paused")
    })
    public static class DownloadMigration implements AutoMigrationSpec {}

    public abstract DownloadDao downloadDao();

    // Migrations are defined as static constants to be referenced by the Hilt Module
    public static final Migration MIGRATION_1_2 = new Migration(1, 2) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_referer_url' TEXT DEFAULT NULL");
        }
    };

    public static final Migration MIGRATION_2_3 = new Migration(2, 3) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_filtered' INTEGER NOT NULL DEFAULT 0");
        }
    };

    public static final Migration MIGRATION_3_4 = new Migration(3, 4) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_encrypted' INTEGER NOT NULL DEFAULT 0");
        }
    };

    public static final Migration MIGRATION_4_5 = new Migration(4, 5) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_thumbnail_duration' INTEGER NOT NULL DEFAULT 0");
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_duration' INTEGER NOT NULL DEFAULT 0");
        }
    };

    public static final Migration MIGRATION_5_6 = new Migration(5, 6) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_duration_formatted' TEXT DEFAULT NULL");
        }
    };

    public static final Migration MIGRATION_6_7 = new Migration(6, 7) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_parent_id' INTEGER NOT NULL DEFAULT 0");
        }
    };

    public static final Migration MIGRATION_7_8 = new Migration(7, 8) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_safe' INTEGER NOT NULL DEFAULT 0");
        }
    };

    // Note: Migration 8 to 9 in your original added 'file_safe' again.
    // If version 9 is required, ensure it performs a valid operation.
    public static final Migration MIGRATION_8_9 = new Migration(8, 9) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            // Placeholder for actual version 9 changes if different from version 8
        }
    };

    /**
     * Adds the {@code file_thumbnail_unavailable} negative-cache column.
     * Default 0 = unknown / behave as before — the column only flips to 1
     * after every decoder in the Glide chain has failed for a completed
     * file, at which point subsequent paging accesses short-circuit to
     * the static mime icon instead of re-running the failing chain.
     */
    public static final Migration MIGRATION_9_10 = new Migration(9, 10) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_thumbnail_unavailable' INTEGER NOT NULL DEFAULT 0");
        }
    };

    /**
     * Indices for the paging queries. Pre-migration the downloads list
     * fell back to a full table scan on every page request because every
     * paging query filters on file_safe and sorts on file_date /
     * file_status — and the table had no index covering either.
     *
     * Index names follow Room's generated convention
     * ({@code index_<table>_<col>[_<col>...]}) so the schema validator
     * matches the @Entity declaration on first load after the bump.
     */
    public static final Migration MIGRATION_10_11 = new Migration(10, 11) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_download_file_safe_file_date` "
                            + "ON `download` (`file_safe`, `file_date`)");
            database.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_download_file_safe_file_status` "
                            + "ON `download` (`file_safe`, `file_status`)");
        }
    };

    public static final Migration MIGRATION_11_12 = new Migration(11, 12) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE 'download' ADD COLUMN 'file_language' TEXT DEFAULT NULL");
        }
    };
}