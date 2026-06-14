import { v } from "convex/values";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { createLogger } from "./logging.js";
import {
  cancelMonitor,
  ensureMonitorBehind,
  getWorker,
  getWorkerState,
  startLoop,
} from "./kick.js";

/**
 * Liveness watchdog. Scheduled ~`monitorLagMs` after the loop's next run by
 * the scheduling path, and pushed back as the loop keeps running. It therefore
 * only fires if the loop failed to run on time:
 *  - worker idle → nothing to watch, clear ourselves.
 *  - loop runner dead → restart the loop.
 *  - loop runner still pending/running → we fired early; re-arm behind it.
 */
export const monitor = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const worker = await getWorker(ctx, name);
    if (!worker) return; // worker was deleted

    const console = createLogger(worker.config.logLevel);

    if (worker.state.kind === "idle") {
      await cancelMonitor(ctx, worker);
      console.debug(`[monitor] "${name}" idle, stopping`);
      return;
    }

    const state = await getWorkerState(ctx, name);
    if (await isLoopDead(ctx, state?.runnerId)) {
      console.error(`[monitor] "${name}" loop is not running — restarting`);
      console.event("restart", { name });
      // startLoop schedules a fresh runner and re-arms the monitor behind it.
      await startLoop(ctx, worker, 0);
      return;
    }

    // Loop is alive (scheduled or running) but we fired anyway — re-arm behind
    // its next run so we keep trailing it.
    const loopRunAtMs =
      worker.state.kind === "waiting" ? worker.state.runAtMs : Date.now();
    await ensureMonitorBehind(ctx, worker._id, loopRunAtMs);
  },
});

async function isLoopDead(
  ctx: MutationCtx,
  runnerId: Id<"_scheduled_functions"> | undefined,
): Promise<boolean> {
  if (!runnerId) return true;
  const fn = await ctx.db.system.get("_scheduled_functions", runnerId);
  if (!fn) return true;
  // pending / inProgress → scheduled or running: healthy.
  return fn.state.kind !== "pending" && fn.state.kind !== "inProgress";
}
