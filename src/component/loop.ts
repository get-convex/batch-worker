import { v, type Value } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { env, internalMutation } from "./_generated/server.js";
import { runSnapshotQuery } from "./future.js";
import { createLogger } from "./logging.js";
import { getWorker, scheduleLoop } from "./kick.js";
import {
  DEFAULT_CONFIG,
  type BatchQueryArgs,
  type BatchResult,
  type WorkerResult,
} from "./shared.js";

// Raw syscall for the (internal, unstable) retry-on-change feature. There's no
// importable class, only this syscall, which uncatchably aborts execution: the
// mutation's writes are discarded and it re-runs when its read set is
// invalidated or the optional deadline passes. Only valid from a top-level
// (non-nested) scheduled mutation — which `loop` is.
declare const Convex: { syscall: (op: string, jsonArgs: string) => string };

function requestRetry(options: { timeoutMs?: number } = {}): never {
  Convex.syscall("1.0/requestRetry", JSON.stringify(options));
  throw new Error("unreachable: requestRetry terminates execution");
}

/**
 * The worker's main loop — a scheduled, top-level mutation. Each run:
 *  - scans for work with a *snapshot* read (no OCC dependency while draining),
 *  - if there's a batch: runs the worker mutation and reschedules itself
 *    (committing this transaction),
 *  - if the snapshot looks idle: re-reads with a real (dependency-taking) query
 *    to catch a racing insert and, crucially, to put the work query's reads
 *    into this transaction's read set, then **suspends** via `requestRetry`.
 *    Inserting new work invalidates that read set and reactively re-runs the
 *    loop; a `timeoutMs` from the query bounds the wait.
 *
 * At most one continuation exists per worker at a time (a scheduled run on the
 * work path, or a single suspended run on the idle path), so no generation
 * bookkeeping is needed. If the work query or worker mutation throws, the loop
 * suspends and retries after `retryBackoffMs` instead of dying.
 */
export const loop = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const console = createLogger(env.LOG_LEVEL);
    const worker = await getWorker(ctx, name);
    if (!worker) {
      console.debug(`[loop] "${name}" worker not found — exiting`);
      return; // worker was deleted
    }
    if (worker.status.kind === "stopped") {
      console.debug(`[loop] "${name}" stopped — exiting`);
      return; // stop() halted us; only start() resumes
    }

    const queryArgs: BatchQueryArgs = { name };
    const queryRef = worker.workQuery as unknown as FunctionHandle<
      "query",
      BatchQueryArgs,
      BatchResult<Value>
    >;

    try {
      // Snapshot read: no OCC dependency, so concurrent inserts while we drain
      // don't force this loop to retry.
      const snap = (await runSnapshotQuery(
        queryRef,
        queryArgs,
      )) as BatchResult<Value>;

      if (snap && "batch" in snap) {
        const ret = await runBatch(ctx, worker.workerMutation, snap.batch);
        const debounceMs = ret?.debounceMs ?? 0;
        await scheduleLoop(ctx, worker, debounceMs);
        return;
      }

      // Snapshot says idle. Re-read with a real dependency to (a) catch an
      // insert that raced the snapshot and (b) subscribe to the work query's
      // read set so a future insert reactively wakes us.
      const real = (await ctx.runQuery(
        queryRef,
        queryArgs,
      )) as BatchResult<Value>;
      if (real && "batch" in real) {
        console.warn(`[loop] "${name}" snapshot query mismatch`);
        await scheduleLoop(ctx, worker, 0);
        return;
      }

      // No work: suspend until an insert invalidates our read set, or (if the
      // query gave one) until the timeout deadline. `requestRetry` aborts
      // uncatchably, so the surrounding try/catch does not catch it.
      const timeoutMs = real?.kind === "idle" ? real.timeoutMs : undefined;
      console.debug(`[loop] "${name}" → suspended`);
      requestRetry({ timeoutMs });
    } catch (e) {
      // A genuine failure in the work query or worker mutation. Suspend and
      // retry after a backoff instead of dying (replaces the old monitor).
      const backoffMs =
        worker.config.retryBackoffMs ?? DEFAULT_CONFIG.retryBackoffMs;
      console.error(`[loop] "${name}" failed — retrying in ${backoffMs}ms`, e);
      console.event("retry", { name });
      requestRetry({ timeoutMs: backoffMs });
    }
  },
});

/** Run the worker mutation for a batch, committing in this transaction. */
async function runBatch(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  workerMutation: string,
  batch: Value,
): Promise<WorkerResult> {
  const mutationRef = workerMutation as unknown as FunctionHandle<
    "mutation",
    any,
    WorkerResult
  >;
  return ctx.runMutation(mutationRef, batch);
}
