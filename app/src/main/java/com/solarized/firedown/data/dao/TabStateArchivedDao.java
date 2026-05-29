package com.solarized.firedown.data.dao;

import androidx.lifecycle.LiveData;
import androidx.paging.PagingSource;
import androidx.room.Dao;
import androidx.room.Delete;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;

import com.solarized.firedown.data.entity.TabStateArchivedEntity;

import java.util.List;

@Dao
public interface TabStateArchivedDao {

    @Query("SELECT * FROM tabstate")
    List<TabStateArchivedEntity> getAllRaw();

    /**
     * Live count of tabs archived at or after {@code sinceMs}. Powers the
     * "X tabs archived in the last [interval]" banner — TabsFragment
     * passes {@code now - interval} so the banner reflects only tabs
     * archived inside the user's chosen window. Rows from before the
     * v1 → v2 migration carry {@code archived_at = 0} and so never
     * count, even when the user's window extends to epoch-zero.
     */
    @Query("SELECT COUNT(*) FROM tabstate WHERE archived_at >= :sinceMs AND archived_at > 0")
    LiveData<Integer> getCountSinceLive(long sinceMs);

    /**
     * PagingSource for Paging 3.
     * Uses file_date DESC to show the most recent tabs first.
     */
    @Query("SELECT * FROM tabstate ORDER BY file_date DESC")
    PagingSource<Integer, TabStateArchivedEntity> getArchive();

    @Query("SELECT * FROM tabstate WHERE uid = :id")
    LiveData<TabStateArchivedEntity> getTabState(int id);

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    Long insert(TabStateArchivedEntity tabStateArchivedEntity);

    /**
     * Used for background tasks (like GeckoInspectTask)
     * where we are already on a background thread.
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    long insertSync(TabStateArchivedEntity tabStateArchivedEntity);

    @Delete
    Integer delete(TabStateArchivedEntity tabStateArchivedEntity);

    @Query("DELETE FROM tabstate WHERE uid = :id")
    Integer deleteById(int id);

    @Query("DELETE FROM tabstate")
    Integer deleteAll();
}