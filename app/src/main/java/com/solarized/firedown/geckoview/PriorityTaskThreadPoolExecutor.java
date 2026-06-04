package com.solarized.firedown.geckoview;

import android.util.Log;

import androidx.lifecycle.LiveData;
import androidx.lifecycle.MutableLiveData;

import java.util.Comparator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.PriorityBlockingQueue;
import java.util.concurrent.atomic.AtomicInteger;


public class PriorityTaskThreadPoolExecutor {

    private static final String TAG = PriorityTaskThreadPoolExecutor.class.getSimpleName();

    private final static int NUMBER_OF_CORES = Runtime.getRuntime().availableProcessors();

    private final static int NETWORK_CORE_POOL_SIZE = NUMBER_OF_CORES / 2;

    public static final int PRIORITY_HIGH = 1;

    public static final int PRIORITY_NORMAL = 10;

    public static final int PRIORITY_LOW = 100;

    /**
     * Demotion floor for a task whose tab isn't the foreground one. Strictly
     * worse (larger) than every base priority — {@link #PRIORITY_HIGH},
     * {@link #PRIORITY_NORMAL}, {@link #PRIORITY_LOW} — so any foreground task
     * outranks any background one.
     *
     * <p>Why a level <em>below</em> LOW is needed: generic (non-media) captures
     * carry a base of {@code PRIORITY_LOW}. If background tasks were merely
     * floored at {@code PRIORITY_LOW} too, a tab you just switched into whose own
     * captures are also generic would <em>tie</em> with the previous tab's
     * backlog — switch into a tab behind 200 queued LOW items and your new
     * captures still wait behind them. Demoting the backlog to a priority no
     * foreground task can hold guarantees the current tab's work runs first
     * regardless of its base.</p>
     */
    public static final int PRIORITY_BACKGROUND = 1000;

    private static final int PRIORITY_CAPACITY = 100;

    private final PriorityBlockingQueue<Task> awaitingTasks;

    private final ExecutorService executor;

    private final int corePoolSize;

    private final AtomicInteger poolSize;

    /**
     * Count of submitted-but-not-finished inspect tasks (queued + running),
     * across all tabs. Incremented when a task is offered, decremented in the
     * run's {@code finally} so aborts/failures count too. Exposed as LiveData so
     * the capture UI can show a "scanning…" indicator while work is pending
     * (the gap where a video can take seconds to appear after the sheet opens).
     */
    private final AtomicInteger inFlight = new AtomicInteger(0);

    private final MutableLiveData<Integer> inFlightLive = new MutableLiveData<>(0);

    /**
     * Foreground tab. A queued task keeps its base priority while its tab is
     * current and is demoted to {@link #PRIORITY_BACKGROUND} otherwise, so
     * switching tabs re-prioritizes the backlog. Volatile: read in {@link
     * #effectivePriority}, mutated only under {@code this}. {@code -1} = unknown,
     * treat every task as foreground (no wrongful demotion before the first tab
     * is known).
     */
    private volatile int currentTabId = -1;


    /**
     * Creates a new {@code TimeoutTaskThreadPoolExecutor} with the
     * given core pool size.
     * The pool should be greater or equals than 2 because one thread is reserved
     * to schedule cancellation task.
     *
     * @param corePoolSize the number of threads to keep in the pool, even
     *        if they are idle, unless {@code allowCoreThreadTimeOut} is set
     * @throws IllegalArgumentException if {@code corePoolSize < 0}
     */
    public PriorityTaskThreadPoolExecutor() {
        this.awaitingTasks = new PriorityBlockingQueue<>(PRIORITY_CAPACITY, new PriorityFutureComparator());
        this.executor = Executors.newFixedThreadPool(NUMBER_OF_CORES/2);
        this.corePoolSize = NETWORK_CORE_POOL_SIZE;
        this.poolSize = new AtomicInteger(0);
    }

    /**
     * @param basePriority the urlType-derived priority (its value when the tab
     *                     is in the foreground); the executor demotes it to
     *                     {@link #PRIORITY_BACKGROUND} (below every base
     *                     priority) while {@code tabId} isn't the current tab.
     */
    public void execute(GeckoInspectTask task, int basePriority, int tabId) {
        Log.d(TAG, "execute: " + awaitingTasks.size());
        Task t = new Task(task, basePriority, tabId);
        t.priority = effectivePriority(t);
        inFlightLive.postValue(inFlight.incrementAndGet());
        awaitingTasks.offer(t);
        executeWaitingTask();
    }


    public boolean isTerminated() {
        return executor.isTerminated();
    }

    /** In-flight inspect tasks (queued + running) across all tabs. */
    public LiveData<Integer> getInFlight() {
        return inFlightLive;
    }

    /**
     * Drop queued (not-yet-started) inspect tasks for a closed tab, so its
     * backlog doesn't keep occupying the pool and delay the next tab's captures.
     * Already-running tasks are left to finish (there are only a few, and they
     * aren't interruptible). Each removed task is decremented from the in-flight
     * count — it was counted at execute() and its run-finally will never fire.
     */
    public synchronized void cancelTab(int tabId) {
        int removed = 0;
        for (Task t : awaitingTasks.toArray(new Task[0])) {
            if (t != null && t.tabId == tabId && awaitingTasks.remove(t)) {
                removed++;
            }
        }
        if (removed > 0) {
            Log.d(TAG, "cancelTab " + tabId + " dropped " + removed + " queued task(s)");
            int n = inFlight.addAndGet(-removed);
            inFlightLive.postValue(Math.max(0, n));
        }
    }

    /**
     * Set the foreground tab and re-prioritize the pending queue: tasks for the
     * new current tab regain their base priority, all others drop to
     * {@link #PRIORITY_BACKGROUND} — a level below every base priority, so even
     * the current tab's LOW-base (generic) captures outrank a heavy background
     * tab's backlog instead of tying with it.
     *
     * <p>{@code synchronized} on the same monitor as {@link #cancelTab} and
     * {@link #executeWaitingTask}, which is what makes the "switch then close
     * (or close mid-switch)" race safe: the drain/recompute/re-offer here and a
     * tab-close's remove can't interleave — they run one fully then the other,
     * in either order, with a consistent result and correct in-flight count.
     * Holding the monitor across the drain also stops {@code executeWaitingTask}
     * from polling the transiently-empty queue. ({@code execute}'s offer isn't
     * on the monitor, but the queue is thread-safe and a task offered during the
     * window simply coexists with the re-offered ones.)</p>
     */
    public synchronized void setCurrentTab(int tabId) {
        if (tabId == currentTabId) {
            return;
        }
        currentTabId = tabId;
        if (awaitingTasks.isEmpty()) {
            return;
        }
        java.util.ArrayList<Task> pending = new java.util.ArrayList<>(awaitingTasks.size());
        awaitingTasks.drainTo(pending);
        for (Task t : pending) {
            t.priority = effectivePriority(t);
        }
        awaitingTasks.addAll(pending);
        executeWaitingTask();
    }

    /** Base priority while the task's tab is current (or the tab is still
     *  unknown); demoted to {@link #PRIORITY_BACKGROUND} for any other tab so a
     *  foreground task always outranks a background one — even when both share
     *  the same {@link #PRIORITY_LOW} base. */
    private int effectivePriority(Task t) {
        int ct = currentTabId;
        return (ct == -1 || t.tabId == ct) ? t.basePriority : PRIORITY_BACKGROUND;
    }

    private synchronized void executeWaitingTask() {
        if (executor.isShutdown()) {
            return;
        }

        int poolAvailable = corePoolSize-poolSize.get();
        Log.d(TAG, "executeWaitingTask: " + poolAvailable);
        if (poolAvailable > 1) {
            final Task nextTask = awaitingTasks.poll();
            if (nextTask != null) {
                poolSize.incrementAndGet();
                executor.submit(() -> {
                    try {
                        nextTask.task.run();
                    } finally {
                        Log.w(TAG, "taskHandler Finish");
                        inFlightLive.postValue(inFlight.decrementAndGet());
                        poolSize.decrementAndGet();
                        executeWaitingTask();
                    }
                });
            }
        }
    }

    private static class Task {
        final GeckoInspectTask task;
        final int basePriority;   // urlType-derived priority (its foreground value)
        final int tabId;
        int priority;             // effective priority used for queue ordering;
                                  // recomputed on a tab switch (mutated only off-queue)

        public Task(GeckoInspectTask task, int basePriority, int tabId) {
            this.task = task;
            this.basePriority = basePriority;
            this.tabId = tabId;
            this.priority = basePriority;
        }

        public int getPriority(){
            return priority;
        }

    }


    private static class PriorityFutureComparator implements Comparator<Task> {
        public int compare(Task o1, Task o2) {
            if (o1 == null && o2 == null)
                return 0;
            else if (o1 == null)
                return -1;
            else if (o2 == null)
                return 1;
            else {
                int p1 = o1.getPriority();
                int p2 = o2.getPriority();

                return Integer.compare(p1, p2);
            }
        }
    }


}
