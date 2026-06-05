import { v, type Infer } from "convex/values";
import { logLevel, DEFAULT_LOG_LEVEL } from "./logging.js";

export const MS = 1;
export const SECOND = 1000 * MS;
export const MINUTE = 60 * SECOND;

/**
 * Configuration for a worker's main loop.
 *
 * The poll/cooldown knobs only matter while the loop is "cooling down" — the
 * window after it drains its queue where it keeps polling so newly-inserted
 * work is picked up promptly without paying the cost of a fresh start.
 */
export const vConfig = v.object({
  /**
   * How long the loop waits before its first batch after being kicked from
   * idle. Lets a burst of inserts accumulate so they're processed together.
   */
  debounceMs: v.number(),
  /**
   * While cooling down (queue is empty but recently had work), how long to
   * wait between polling the work query.
   */
  pollIntervalMs: v.number(),
  /**
   * How long the loop keeps polling an empty queue before going idle. A
   * longer cooldown trades some wasted polls for lower latency on the next
   * burst of work.
   */
  cooldownMs: v.number(),
  /**
   * How long to wait before re-running the loop after the worker mutation
   * throws. The loop keeps retrying (and logging) until the code is fixed.
   */
  errorBackoffMs: v.number(),
  /**
   * How often the monitor checks that the loop is still alive (and restarts
   * it if it died unexpectedly).
   */
  monitorIntervalMs: v.number(),
  logLevel,
});
export type Config = Infer<typeof vConfig>;

export const DEFAULT_CONFIG: Config = {
  debounceMs: 100,
  pollIntervalMs: 250,
  cooldownMs: 10 * SECOND,
  errorBackoffMs: 1 * MINUTE,
  monitorIntervalMs: 1 * MINUTE,
  logLevel: DEFAULT_LOG_LEVEL,
};

/**
 * The run state of a worker, stored on the (rarely-written) `workers` doc so
 * that `ensureRunning` can cheaply decide whether a kick is needed without
 * taking a read dependency on the high-churn loop state.
 *
 * - `idle`: no loop is scheduled. `ensureRunning` must kick it.
 * - `active`: a loop chain exists (executing, polling, or scheduled). New
 *   work will be picked up by the running loop, so `ensureRunning` no-ops.
 */
export const vRunState = v.union(
  v.object({ kind: v.literal("idle") }),
  v.object({ kind: v.literal("active") }),
);
export type RunState = Infer<typeof vRunState>;

/**
 * What a worker mutation may return to influence the loop. All fields are
 * optional; returning nothing (or null) uses the defaults.
 */
export type WorkerResult = null | {
  /**
   * Delay in ms before the loop runs again. Default: re-run immediately.
   * Return a large value to back off (e.g. when rate limited).
   */
  runAfter?: number;
  /**
   * Updated args to pass to the work query on the next iteration, e.g. to
   * advance a cursor. Persists across iterations.
   */
  queryArgs?: unknown;
};
