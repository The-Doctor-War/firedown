package com.solarized.firedown.phone;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.MenuItem;

import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.Toolbar;

import com.google.android.material.snackbar.Snackbar;
import com.solarized.firedown.IntentActions;
import com.solarized.firedown.Keys;
import com.solarized.firedown.R;
import com.solarized.firedown.data.entity.DownloadEntity;
import com.solarized.firedown.manager.tasks.TaskManager;
import com.solarized.firedown.phone.fragments.GifMakerFragment;

import java.util.ArrayList;

/**
 * Hosts the trim/options screen for GIF creation.
 *
 * <p>Mirrors {@link PlayerActivity} in shape: takes a single
 * {@link DownloadEntity} via {@link Keys#ITEM_ID} extras, hosts a fragment,
 * and exposes a toolbar action that fires the encode task. The task itself
 * still runs in {@link TaskManager} — this activity just collects the
 * trim/fps/width parameters and forwards them on the start intent.
 */
public class GifMakerActivity extends AppCompatActivity {

    private static final String TAG = GifMakerActivity.class.getSimpleName();

    private GifMakerFragment mFragment;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_gif_maker);

        Toolbar toolbar = findViewById(R.id.toolbar);
        setSupportActionBar(toolbar);
        toolbar.setNavigationOnClickListener(v -> finish());

        DownloadEntity entity = getIntent().getParcelableExtra(Keys.ITEM_ID);

        if (entity == null) {
            Log.w(TAG, "GifMakerActivity started without DownloadEntity");
            finish();
            return;
        }

        if (savedInstanceState == null) {
            Bundle args = new Bundle();
            args.putParcelable(Keys.ITEM_ID, entity);

            mFragment = new GifMakerFragment();
            mFragment.setArguments(args);

            getSupportFragmentManager()
                    .beginTransaction()
                    .setReorderingAllowed(true)
                    .replace(R.id.content_frame, mFragment, GifMakerFragment.class.getSimpleName())
                    .commit();
        } else {
            mFragment = (GifMakerFragment) getSupportFragmentManager()
                    .findFragmentByTag(GifMakerFragment.class.getSimpleName());
        }
    }

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        getMenuInflater().inflate(R.menu.menu_gif_maker, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == R.id.action_create_gif) {
            startGifMakerTask();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    private void startGifMakerTask() {
        if (mFragment == null) return;

        GifMakerFragment.Args args = mFragment.collectArgs();
        DownloadEntity entity = mFragment.getDownloadEntity();

        if (args.endMs > 0 && args.endMs <= args.startMs) {
            Snackbar.make(findViewById(R.id.content_frame),
                    R.string.gif_maker_invalid_range, Snackbar.LENGTH_LONG).show();
            return;
        }

        ArrayList<DownloadEntity> entities = new ArrayList<>(1);
        entities.add(entity);

        Intent intent = new Intent(this, TaskManager.class);
        intent.setAction(IntentActions.DOWNLOAD_START_MAKE_GIF);
        intent.putExtra(Keys.ITEM_LIST_ID, entities);
        intent.putExtra(Keys.GIF_START_MS, args.startMs);
        intent.putExtra(Keys.GIF_END_MS, args.endMs);
        intent.putExtra(Keys.GIF_FPS, args.fps);
        intent.putExtra(Keys.GIF_WIDTH, args.width);
        startService(intent);

        /* Hand control back to the downloads screen so the bottom progress
         * view shows the encode in progress. */
        finish();
    }
}
