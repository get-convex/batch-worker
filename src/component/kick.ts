import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { createLogger } from "./logging.js";
import { type Config, DEFAULT_CONFIG } from "./shared.js";

export async function getWorker(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("workers")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
}

export async function getWorkerState(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("workerState")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
}

/**
 * Idempotently make sure the named worker exists and is processing work.
 *
 * Cheap and OCC-friendly in the common case: when the loop is already active
 * it only reads the `workers` doc and returns. Call it right after inserting
 * work into your own table.
 */
export async function ensureRunning(
  ctx: MutationCtx,
  args: {
    name: string;
    workQuery: string;
    workerMutation: string;
    queryArgs: unknown;
    config: Partial<Config>;
  },
): Promise<void> {
  const config: Config = { ...DEFAULT_CONFIG, ...args.config };
  const console = createLogger(config.logLevel);
  const worker = await getWorker(ctx, args.name);

  if (!worker) {
    await ctx.db.insert("workerState", {
      name: args.name,
      generation: 0n,
      queryArgs: args.queryArgs ?? {},
      lastWorkTs: 0,
      heartbeat: 0,
    });
    const workerId = await ctx.db.insert("workers", {
      name: args.name,
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      config,
      state: { kind: "idle" },
    });
    await kick(ctx, (await ctx.db.get("workers", workerId))!);
    return;
  }

  if (worker.state.kind === "active") {
    // A loop is already running (or polling/scheduled); it will pick up the
    // newly-inserted work via its query. Crucially we don't write anything,
    // so concurrent inserts don't OCC-conflict with each other or the loop.
    console.debug(`[ensureRunning] "${args.name}" already active`);
    return;
  }

  // Idle: refresh handles/config (the deployed code may have changed) and
  // kick. Safe to write here because no loop is running to conflict with.
  await ctx.db.patch("workers", worker._id, {
    workQuery: args.workQuery,
    workerMutation: args.workerMutation,
    config,
  });
  await kick(ctx, (await ctx.db.get("workers", worker._id))!);
}

/**
 * Transition the worker to active and schedule its loop after the configured
 * debounce, then make sure a monitor is watching it. Bumps the generation so
 * any stale scheduled loop exits. Use this from `ensureRunning`.
 */
export async function kick(
  ctx: MutationCtx,
  worker: Doc<"workers">,
): Promise<void> {
  await startLoop(ctx, worker);
  await ensureMonitor(ctx, worker._id);
}

/**
 * Schedule a fresh loop chain and mark the worker active. Does NOT touch the
 * monitor — the monitor restarts the loop with this and reschedules itself
 * separately (calling `ensureMonitor` from here would see the in-progress
 * monitor and skip rescheduling, silently halting monitoring).
 */
export async function startLoop(
  ctx: MutationCtx,
  worker: Doc<"workers">,
): Promise<void> {
  const state = (await getWorkerState(ctx, worker.name))!;
  const generation = state.generation + 1n;
  const runnerId = await ctx.scheduler.runAfter(
    worker.config.debounceMs,
    internal.loop.loop,
    { name: worker.name, generation },
  );
  await ctx.db.patch("workerState", state._id, {
    generation,
    runnerId,
    heartbeat: Date.now(),
  });
  await ctx.db.patch("workers", worker._id, {
    state: { kind: "active" },
  });
}

/**
 * Make sure a monitor is scheduled for the worker. The monitor reschedules
 * itself while the worker is active, so this only schedules a new one when
 * none is alive.
 */
export async function ensureMonitor(
  ctx: MutationCtx,
  workerId: Doc<"workers">["_id"],
): Promise<void> {
  const worker = (await ctx.db.get("workers", workerId))!;
  if (worker.monitorId) {
    const fn = await ctx.db.system.get(
      "_scheduled_functions",
      worker.monitorId,
    );
    if (fn && (fn.state.kind === "pending" || fn.state.kind === "inProgress")) {
      return;
    }
  }
  const monitorId = await ctx.scheduler.runAfter(
    worker.config.monitorIntervalMs,
    internal.monitor.monitor,
    { name: worker.name },
  );
  await ctx.db.patch("workers", workerId, { monitorId });
}

/**
 * Stop the worker: cancel its loop and monitor and mark it idle. New work
 * (plus an `ensureRunning` call) will start it again.
 */
// export async function stop(ctx: MutationCtx, name: string): Promise<void> {
//   const worker = await getWorker(ctx, name);
//   if (!worker) return;
//   const state = await getWorkerState(ctx, name);
//   if (state?.runnerId) {
//     await cancelIfPending(ctx, state.runnerId);
//     await ctx.db.patch("workerState", state._id, { runnerId: undefined });
//   }
//   if (worker.monitorId) {
//     await cancelIfPending(ctx, worker.monitorId);
//   }
//   await ctx.db.patch("workers", worker._id, {
//     state: { kind: "idle" },
//     monitorId: undefined,
//   });
// }

async function cancelIfPending(
  ctx: MutationCtx,
  id: Id<"_scheduled_functions">,
): Promise<void> {
  const fn = await ctx.db.system.get("_scheduled_functions", id);
  if (fn && fn.state.kind === "pending") {
    await ctx.scheduler.cancel(id);
  }
}
