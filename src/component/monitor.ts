import { v } from "convex/values";
import { env, internalMutation } from "./_generated/server.js";
import {
  cancelMonitor,
  continueRunning,
  ensureMonitored,
  getOrCreateWorkerState,
  getWorker,
} from "./kick.js";
import { createLogger } from "./logging.js";

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
    const console = createLogger(env.LOG_LEVEL);
    if (!worker) {
      console.debug(`[monitor] "${name}" not found, bailing`);
      return;
    }

    const state = await getOrCreateWorkerState(ctx, worker);
    if (worker.status.kind === "idle") {
      await cancelMonitor(ctx, state);
      console.debug(`[monitor] "${name}" idle, stopping`);
      return;
    }

    const loop =
      state?.runnerId &&
      (await ctx.db.system.get("_scheduled_functions", state?.runnerId));
    const alive =
      loop &&
      (loop.state.kind === "pending" || loop.state.kind === "inProgress");
    if (!alive) {
      console.error(`[monitor] "${name}" loop is not running — restarting`);
      console.event("restart", { name });
      await continueRunning(ctx, worker, 0);
      return;
    }

    // Loop is alive (scheduled or running) but we fired anyway — re-arm behind
    // its next run so we keep trailing it.
    const loopRunAtMs =
      loop.state.kind === "pending" ? loop.scheduledTime : Date.now();
    await ensureMonitored(ctx, worker, loopRunAtMs);
  },
});
