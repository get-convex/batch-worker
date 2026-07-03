import { v, type Infer, type Validator } from "convex/values";

export const MS = 1;
export const SECOND = 1000 * MS;
export const MINUTE = 60 * SECOND;

// When the loop's work query or worker mutation throws, the loop suspends and
// retries after this long by default (the retry-on-change deadline). Replaces
// the old scheduled monitor's restart cadence.
export const RETRY_BACKOFF_MS = 60 * SECOND;

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
   * How long the loop waits before retrying after its work query or worker
   * mutation throws. The loop suspends (retry-on-change) and re-runs after this
   * deadline, so a transient failure doesn't kill the worker.
   */
  retryBackoffMs: v.number(),
});
export type Config = Infer<typeof vConfig>;

export const DEFAULT_CONFIG: Config = {
  debounceMs: 0,
  retryBackoffMs: RETRY_BACKOFF_MS,
};

/**
 * The run state of a worker, on the `workers` doc.
 *
 * - `running`: the loop is live — scheduled, executing, or suspended (waiting
 *   for new work to invalidate its read set, or for an idle timeout). A `ping`
 *   is a no-op; inserting work wakes the suspended loop reactively.
 * - `stopped`: the loop was halted by `stop`. `ping` is ignored; only `start`
 *   resumes it.
 */
export const vStatus = v.union(
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("stopped") }),
);
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
    v.object({ kind: v.optional(v.literal("work")), batch }),
    v.object({
      kind: v.literal("idle"),
      /**
       * Wake and re-run the query again by this long from now at the latest,
       * even if no new work arrives. Inserting work wakes the loop sooner
       * (reactively). If omitted, the loop suspends until new work arrives.
       */
      timeoutMs: v.optional(v.number()),
    }),
  );
}

/**
 * What a work query returns: a `batch` of work to process, or `idle` with an
 * optional `timeoutMs` hint for when to look again.
 *
 * @typeParam Batch - the shape passed to your worker mutation.
 */
export type BatchResult<Batch> =
  | { kind: "work"; batch: Batch }
  | {
      kind: "idle";
      /**
       * Wake and re-run by this long from now at the latest, even without new
       * work. Inserting work wakes the loop sooner. Omit to suspend until new
       * work arrives.
       */
      timeoutMs?: number;
    };

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
  }),
);
export type WorkerResult = Infer<typeof vWorkerResult>;
