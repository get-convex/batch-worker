import { v } from "convex/values";
import { internalMutation } from "./functions.js";
import {
  cancelMonitor,
  getOrCreateWorkerState,
  getWorker,
  repairRunningWorker,
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
    if (!worker) {
      ctx.log.debug(`[monitor] "${name}" not found, bailing`);
      return;
    }

    const state = await getOrCreateWorkerState(ctx, worker);
    if (worker.status.kind !== "running") {
      await cancelMonitor(ctx, state);
      ctx.log.debug(`[monitor] "${name}" ${worker.status.kind}, no-op`);
      return;
    }

    if (await repairRunningWorker(ctx, worker)) {
      ctx.log.error(`[monitor] "${name}" loop is not running — restarting`);
      ctx.log.event("restart", { name });
    }
  },
});
