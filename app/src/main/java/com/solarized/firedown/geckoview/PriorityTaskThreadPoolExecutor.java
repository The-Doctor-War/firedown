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

    public void execute(GeckoInspectTask task, int priority, int tabId) {
        Log.d(TAG, "execute: " + awaitingTasks.size());
        inFlightLive.postValue(inFlight.incrementAndGet());
        awaitingTasks.offer(new Task(task, priority, tabId));
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
    public void cancelTab(int tabId) {
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
        GeckoInspectTask task;
        int priority;
        int tabId;

        public Task(GeckoInspectTask task, int priority, int tabId) {
            this.task = task;
            this.priority = priority;
            this.tabId = tabId;
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
