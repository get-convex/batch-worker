import { v, type Value } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { runSnapshotQuery } from "./future.js";
import { createLogger } from "./logging.js";
import {
  continueRunning,
  getWorker,
  getWorkerState,
  goIdle,
  scheduleWaiting,
} from "./kick.js";
import {
  RUNNING_THRESHOLD_MS,
  type BatchQueryArgs,
  type WorkerResult,
} from "./shared.js";

type BatchResult =
  | { kind: "work"; batch: Value }
  | { kind: "idle"; timeoutMs?: number };

/**
 * The worker's main loop. At most one is scheduled/running per worker, enforced
 * by the `generation` check: a stale scheduled loop (superseded by a newer
 * (re)start or the monitor) exits silently.
 *
 * Each iteration runs the work query as a *snapshot* read (no OCC dependency),
 * runs the worker mutation if there's a batch, then reschedules itself:
 *  - more work / no result hint → run again immediately,
 *  - mutation returned debounce/timeout → wait (interruptible) accordingly,
 *  - query reported idle with a timeout → sleep until then,
 *  - query idle within cooldown → poll,
 *  - cooldown elapsed → confirm with a real (dependency) read, then go idle.
 */
export const loop = internalMutation({
  args: { name: v.string(), generation: v.int64() },
  handler: async (ctx, { name, generation }) => {
    const worker = await getWorker(ctx, name);
    const state = await getWorkerState(ctx, name);
    if (!worker || !state) return; // worker was deleted
    const console = createLogger(worker.config.logLevel);

    if (state.generation !== generation) {
      console.debug(
        `[loop] "${name}" superseded (gen ${generation} !== ${state.generation})`,
      );
      return;
    }

    const config = worker.config;
    const now = Date.now();
    const queryArgs: BatchQueryArgs = { name };
    const queryRef = worker.workQuery as unknown as FunctionHandle<
      "query",
      BatchQueryArgs,
      BatchResult
    >;

    // Snapshot read: no OCC dependency, so concurrent inserts while we drain
    // don't force this loop to retry.
    const result = (await runSnapshotQuery(
      worker.workQuery,
      queryArgs as unknown as Record<string, Value>,
    )) as BatchResult | null;

    // ── There's work: run the worker mutation, then reschedule. ──
    if (result && result.kind === "work") {
      let ret: WorkerResult = null;
      try {
        const mutationRef = worker.workerMutation as unknown as FunctionHandle<
          "mutation",
          any,
          WorkerResult
        >;
        ret = await ctx.runMutation(mutationRef, result.batch);
      } catch (e) {
        console.error(`[loop] "${name}" worker mutation threw:`, e);
        console.event("error", {
          name,
          error: e instanceof Error ? e.message : String(e),
        });
        // Hard back off (debounce == timeout, so pings don't interrupt) and
        // retry; keep lastWorkTs so we stay warm.
        await scheduleWaiting(
          ctx,
          worker,
          config.errorBackoffMs,
          config.errorBackoffMs,
        );
        return;
      }
      const debounceMs = ret?.debounceMs ?? 0;
      const timeoutMs = Math.max(ret?.timeoutMs ?? 0, debounceMs);
      if (timeoutMs <= RUNNING_THRESHOLD_MS) {
        await continueRunning(ctx, worker, timeoutMs, now);
      } else {
        await scheduleWaiting(ctx, worker, debounceMs, timeoutMs, now);
      }
      return;
    }

    // ── No work, but the query told us when to look again. ──
    const idleTimeoutMs = result?.kind === "idle" ? result.timeoutMs : undefined;
    if (idleTimeoutMs != null) {
      if (await confirmHasWork(ctx, queryRef, queryArgs)) {
        await continueRunning(ctx, worker, 0);
        return;
      }
      if (idleTimeoutMs <= RUNNING_THRESHOLD_MS) {
        await continueRunning(ctx, worker, idleTimeoutMs);
      } else {
        // debounce 0: a ping can interrupt the sleep at any time.
        await scheduleWaiting(ctx, worker, 0, idleTimeoutMs);
      }
      return;
    }

    // ── No work and no hint: stay warm and poll for the cooldown window. ──
    const sinceWork = now - state.lastWorkTs;
    if (state.lastWorkTs > 0 && sinceWork < config.cooldownMs) {
      await continueRunning(ctx, worker, config.pollIntervalMs);
      return;
    }

    // Cooldown elapsed. Confirm with a real dependency read so a racing insert
    // forces an OCC retry instead of being dropped, then go idle.
    if (await confirmHasWork(ctx, queryRef, queryArgs)) {
      await continueRunning(ctx, worker, 0);
      return;
    }
    await goIdle(ctx, worker, state);
    console.debug(`[loop] "${name}" → idle`);
  },
});

/** A real (dependency-taking) read of the work query. */
async function confirmHasWork(
  ctx: MutationCtx,
  queryRef: FunctionHandle<"query", BatchQueryArgs, BatchResult>,
  queryArgs: BatchQueryArgs,
): Promise<boolean> {
  const confirm = (await ctx.runQuery(queryRef, queryArgs)) as BatchResult | null;
  return !!confirm && confirm.kind === "work";
}
