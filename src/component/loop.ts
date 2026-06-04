import { v, type Value } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { runSnapshotQuery } from "./future.js";
import { createLogger } from "./logging.js";
import { getWorker, getWorkerState } from "./kick.js";
import { type WorkerResult } from "./shared.js";

/**
 * The worker's main loop. There is at most one of these scheduled or running
 * per worker at a time, enforced by the `generation` check: a stale scheduled
 * loop (whose generation has been bumped by a newer kick or by the monitor)
 * exits silently.
 *
 * Each iteration:
 *  1. Runs the user's work query as a *snapshot* read (no OCC dependency).
 *  2. If it returned work, runs the user's worker mutation with it.
 *  3. Reschedules itself: immediately after work, after `pollIntervalMs` while
 *     cooling down, or — once the cooldown expires with no work — confirms
 *     with a real (dependency-taking) read and goes idle.
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
    const queryArgs = (state.queryArgs ?? {}) as Record<string, Value>;
    const queryRef = worker.workQuery as unknown as FunctionHandle<
      "query",
      any,
      Value | null
    >;

    // Snapshot read: doesn't take an OCC dependency, so a burst of concurrent
    // inserts while we drain the queue won't force this loop to retry.
    const work = await runSnapshotQuery(worker.workQuery, queryArgs);

    if (work !== null && work !== undefined) {
      let nextArgs: Record<string, Value> = queryArgs;
      let runAfter: number | undefined;
      try {
        const mutationRef = worker.workerMutation as unknown as FunctionHandle<
          "mutation",
          any,
          WorkerResult
        >;
        const result = await ctx.runMutation(mutationRef, work);
        if (result && typeof result === "object") {
          if (result.queryArgs !== undefined) {
            nextArgs = result.queryArgs as Record<string, Value>;
          }
          if (typeof result.runAfter === "number") {
            runAfter = result.runAfter;
          }
        }
      } catch (e) {
        // Report so the app can alert on it, then back off and retry. The
        // loop keeps running (and failing) until the code is fixed.
        console.error(`[loop] "${name}" worker mutation threw:`, e);
        console.event("error", {
          name,
          error: e instanceof Error ? e.message : String(e),
        });
        await reschedule(ctx, worker, state, generation, config.errorBackoffMs, {
          // Keep the same args; don't advance past work we failed to process.
          lastWorkTs: state.lastWorkTs,
        });
        return;
      }
      // Default to running again immediately — there may be more work, and an
      // empty result next iteration cleanly transitions into cooldown.
      await reschedule(ctx, worker, state, generation, runAfter ?? 0, {
        queryArgs: nextArgs,
        lastWorkTs: Date.now(),
      });
      return;
    }

    // No work in the snapshot. Stay warm and keep polling until the cooldown
    // window elapses, so a trickle of new work is picked up promptly.
    const sinceWork = Date.now() - state.lastWorkTs;
    if (state.lastWorkTs > 0 && sinceWork < config.cooldownMs) {
      console.debug(`[loop] "${name}" cooling down, polling again`);
      await reschedule(
        ctx,
        worker,
        state,
        generation,
        config.pollIntervalMs,
        {},
      );
      return;
    }

    // Cooldown elapsed. Re-run the query with a *real* dependency so a racing
    // insert (committed after our snapshot) forces an OCC retry and we notice
    // the new work instead of going idle and dropping it.
    const confirm = await ctx.runQuery(queryRef, queryArgs);
    if (confirm !== null && confirm !== undefined) {
      console.debug(`[loop] "${name}" found work on confirm, continuing`);
      await reschedule(ctx, worker, state, generation, 0, {});
      return;
    }

    // Genuinely nothing to do — go idle.
    await ctx.db.patch("workerState", state._id, {
      generation,
      heartbeat: Date.now(),
      runnerId: undefined,
    });
    await ctx.db.patch("workers", worker._id, {
      state: { kind: "idle", generation },
    });
    console.debug(`[loop] "${name}" → idle`);
  },
});

/**
 * Schedule the next loop iteration and persist loop state. Bumps the
 * generation so this becomes the only valid runner. Does NOT touch the
 * `workers` doc (stays "active"), keeping `ensureRunning` OCC-free.
 */
async function reschedule(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  state: Doc<"workerState">,
  generation: bigint,
  delayMs: number,
  patch: { queryArgs?: Record<string, Value>; lastWorkTs?: number },
): Promise<void> {
  const nextGen = generation + 1n;
  const runnerId = await ctx.scheduler.runAfter(delayMs, internal.loop.loop, {
    name: worker.name,
    generation: nextGen,
  });
  await ctx.db.patch("workerState", state._id, {
    generation: nextGen,
    runnerId,
    heartbeat: Date.now(),
    ...patch,
  });
}
