import { v, type Infer, type Validator } from "convex/values";

export const MS = 1;
export const SECOND = 1000 * MS;
export const MINUTE = 60 * SECOND;

// Delays at or below this are treated as the loop being "running" (a ping is a
// no-op — the work will be picked up imminently). Longer delays put the loop in
// a "waiting" state that a ping can interrupt. Also the boundary between the
// short cooldown poll and a long sleep.
export const RUNNING_THRESHOLD_MS = 1 * SECOND;
// The monitor is scheduled this long after the loop's next run, so it only
// fires if the loop fails to run (and reschedule the monitor) on time.
export const MONITOR_LAG_MS = 60 * SECOND;
// Refresh the monitor when it would otherwise fire within this window — keeps
// it trailing the loop without rescheduling on every iteration.
export const MONITOR_REFRESH_WITHIN_MS = 10 * SECOND;

/**
 * Configuration for a worker's main loop.
 */
export const vConfig = v.object({
  /**
   * How long the loop waits before its first batch after being started from
   * idle. Lets a burst of inserts accumulate so they're processed together.
   */
  debounceMs: v.number(),
  /**
   * How long to wait before re-running the loop after the worker mutation
   * throws. The loop keeps retrying (and logging) until the code is fixed.
   */
  errorBackoffMs: v.number(),
  /**
   * How long after the loop's scheduled run the monitor is scheduled. The
   * monitor restarts the loop if it didn't run (and push the monitor back) by
   * then.
   */
  monitorLagMs: v.number(),
});
export type Config = Infer<typeof vConfig>;

export const DEFAULT_CONFIG: Config = {
  debounceMs: 100,
  errorBackoffMs: 1 * MINUTE,
  monitorLagMs: MONITOR_LAG_MS,
};

/**
 * The run state of a worker, on the `workers` doc. Written only on transitions
 * (and the occasional monitor refresh), so `ping`/`start` can read it on every
 * insert without OCC-conflicting with the fast-looping loop.
 *
 * - `idle`: no loop scheduled. `ping`/`start` must start it.
 * - `running`: the loop is executing or scheduled to run imminently
 *   (≤ RUNNING_THRESHOLD_MS). A ping is a no-op — work is picked up soon.
 * - `waiting`: the loop is sleeping until `runAtMs`.
 */
export const vRunState = v.union(
  v.object({ kind: v.literal("idle") }),
  v.object({ kind: v.literal("running") }),
  v.object({
    kind: v.literal("waiting"),
    runAtMs: v.number(),
  }),
);
export type RunState = Infer<typeof vRunState>;

export const vStatus = v.object({
  kind: v.union(v.literal("idle"), v.literal("running"), v.literal("waiting")),
  generation: v.int64(),
  lastWorkTs: v.number(),
  heartbeat: v.number(),
});
export type Status = Infer<typeof vStatus>;

// ── The work query / worker mutation contract ──────────────────────────────

/**
 * The args your work query receives. Today just the worker's `name`, so a
 * single query function can serve multiple named queues. Use this as your
 * query's `args` validator for forward compatibility.
 */
export const vBatchQueryArgs = v.object({ name: v.string() });
export type BatchQueryArgs = Infer<typeof vBatchQueryArgs>;

/**
 * Builds the validator for what your work query returns: either a batch of
 * work to process, or an explicit `idle` (optionally with a `timeoutMs` hint
 * for when to check again — e.g. when the next item is scheduled).
 *
 * @example
 * export const getBatch = internalQuery({
 *   args: vBatchQueryArgs,
 *   returns: vBatchResult(v.object({ ids: v.array(v.id("tasks")) })),
 *   handler: ...
 * });
 */
export function vBatchResult<B extends Validator<any, "required", any>>(
  batch: B,
) {
  return v.union(
    v.object({ kind: v.literal("work"), batch }),
    v.object({
      kind: v.literal("idle"),
      /**
       * How long the loop waits before its first batch after being started from
       * idle. Lets a burst of inserts accumulate so they're processed together.
       */
      debounceMs: v.number(),
      /**
       * While cooling down (the query reports idle with no timeout but work was
       * seen recently), how long to wait between polls of the work query.
       */
      pollIntervalMs: v.number(),
      /**
       * How long the loop keeps polling an idle queue before going fully idle.
       */
      cooldownMs: v.number(),
      timeoutMs: v.optional(v.number()),
    }),
  );
}

/**
 * What a worker mutation may return to steer the loop. Returning nothing (or
 * null) re-runs immediately (drain as fast as possible).
 */
export const vWorkerResult = v.union(
  v.null(),
  v.object({
    /**
     * Don't run again — and ignore pings — for at least this long. Use to
     * debounce / batch.
     */
    debounceMs: v.optional(v.number()),
    /**
     * Run again by this long from now at the latest. A ping after the debounce
     * window but before the timeout interrupts and runs sooner. Defaults to
     * `debounceMs` (a hard wait with no interruption).
     */
    timeoutMs: v.optional(v.number()),
  }),
);
export type WorkerResult = Infer<typeof vWorkerResult>;
