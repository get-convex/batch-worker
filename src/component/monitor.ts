import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { createLogger } from "./logging.js";
import { getWorker, getWorkerState, startLoop } from "./kick.js";

/**
 * Periodically checks that an active worker's loop is still alive and restarts
 * it if it died unexpectedly (e.g. an OCC pile-up or a hard scheduler error
 * that the loop's own try/catch didn't cover). Reschedules itself while the
 * worker is active and stops once it goes idle.
 */
export const monitor = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const worker = await getWorker(ctx, name);
    if (!worker) return; // worker was deleted

    const console = createLogger(worker.config.logLevel);

    if (worker.state.kind === "idle") {
      // Nothing to watch; clear our handle so a future kick reschedules us.
      await ctx.db.patch("workers", worker._id, { monitorId: undefined });
      console.debug(`[monitor] "${name}" idle, stopping`);
      return;
    }

    const state = await getWorkerState(ctx, name);
    if (await isLoopDead(ctx, state?.runnerId)) {
      console.error(`[monitor] "${name}" loop is not running — restarting`);
      console.event("restart", { name });
      await startLoop(ctx, worker);
    }

    // Check again later. (We reschedule ourselves whether or not we restarted
    // the loop, so monitoring continues across a restart.)
    const monitorId = await ctx.scheduler.runAfter(
      worker.config.monitorIntervalMs,
      internal.monitor.monitor,
      { name },
    );
    await ctx.db.patch("workers", worker._id, { monitorId });
  },
});

async function isLoopDead(
  ctx: MutationCtx,
  runnerId: Id<"_scheduled_functions"> | undefined,
): Promise<boolean> {
  if (!runnerId) return true;
  const fn = await ctx.db.system.get("_scheduled_functions", runnerId);
  if (!fn) return true;
  // pending / inProgress → the loop is scheduled or running: healthy.
  // success → it finished without rescheduling a successor while still marked
  // active, which means it died mid-flight. failed / canceled → also dead.
  return fn.state.kind !== "pending" && fn.state.kind !== "inProgress";
}
