import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { LogMutationCtx } from "./functions.js";
import {
  type Config,
  DEFAULT_CONFIG,
  MONITOR_REFRESH_WITHIN_MS,
  RUNNING_THRESHOLD_MS,
  MONITOR_LAG_MS,
} from "./shared.js";

export async function getWorker(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("workers")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
}

export async function getOrCreateWorkerState(
  ctx: MutationCtx,
  worker: Doc<"workers">,
) {
  const state = await ctx.db.get("workerState", worker.stateId);
  if (state) return state;
  worker.stateId = await ctx.db.insert("workerState", {
    generation: 0n,
    lastWorkTs: 0,
  });
  await ctx.db.patch("workers", worker._id, { stateId: worker.stateId });
  return (await ctx.db.get("workerState", worker.stateId))!;
}

// ── Public entry points (ping / start / stop) ──────────────────────────────

/**
 * Register-or-refresh a worker and make sure it's running. Carries the work
 * query/mutation + config; creates the worker on first call. Call it right
 * after inserting work.
 *
 * Cheap and OCC-friendly: when the loop is already running it only reads the
 * `workers` doc and returns.
 */
export async function ping(
  ctx: LogMutationCtx,
  args: {
    name: string;
    workQuery: string;
    workerMutation: string;
    config?: Partial<Config> | undefined;
  },
): Promise<void> {
  const worker = await getWorker(ctx, args.name);

  if (!worker) {
    const stateId = await ctx.db.insert("workerState", {
      generation: 0n,
      lastWorkTs: 0,
    });
    const workerId = await ctx.db.insert("workers", {
      name: args.name,
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      config: args.config ?? {},
      status: { kind: "running" },
      stateId,
    });
    const delayMs = args.config?.debounceMs ?? DEFAULT_CONFIG.debounceMs;
    const worker = (await ctx.db.get("workers", workerId))!;
    await scheduleLoopRun(ctx, worker, { delayMs });
    return;
  }

  if (
    args.workQuery !== worker.workQuery ||
    args.workerMutation !== worker.workerMutation ||
    (args.config &&
      (args.config.debounceMs !== worker.config.debounceMs ||
        args.config.monitorLagMs !== worker.config.monitorLagMs))
  ) {
    worker.workQuery = args.workQuery;
    worker.workerMutation = args.workerMutation;
    if (args.config) {
      worker.config = args.config;
    }
    await ctx.db.replace("workers", worker._id, worker);
  }
  if (worker.status.kind !== "idle") {
    ctx.log.debug(`[ping] "${worker.name}" ${worker.status.kind} — no-op`);
    return;
  }
  await wake(ctx, worker);
}

/**
 * Resume an existing worker (e.g. after `stop`) using its stored handles and
 * config. No-ops if the worker was never created with `ping`.
 */
export async function start(ctx: LogMutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const status = worker.status;
  if (status.kind !== "stopped") {
    ctx.log.debug(`[start] "${worker.name}" ${status.kind} — no-op`);
    return;
  }
  await wake(ctx, worker);
}

/**
 * Stop the worker: cancel its loop and monitor and mark it idle.
 * Only `start` will resume it.
 */
export async function stop(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const state = await getOrCreateWorkerState(ctx, worker);
  if (state?.runnerId) {
    await cancelIfPending(ctx, state.runnerId);
    await ctx.db.patch("workerState", state._id, {
      runnerId: undefined,
      generation: state.generation + 1n,
    });
  }
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "stopped" } });
}

// ── Waking the loop ────────────────────────────────────────────────────────

/**
 * Decide whether a ping/start should do anything:
 * - idle    → start a fresh loop (unless there's one scheduled for soon)
 * - running → no-op (work will be picked up imminently).
 */
async function wake(ctx: LogMutationCtx, worker: Doc<"workers">): Promise<void> {
  const state = (await ctx.db.get("workerState", worker.stateId)) ?? {
    runnerId: undefined,
    lastWorkTs: 0,
  };
  const now = Date.now();
  const loop =
    state.runnerId &&
    (await ctx.db.system.get("_scheduled_functions", state.runnerId));
  if (
    loop?.state.kind === "pending" &&
    loop.scheduledTime < now + RUNNING_THRESHOLD_MS
  ) {
    ctx.log.debug(
      `[wake] "${worker.name}" scheduled for immediate execution — no-op`,
    );
    return;
  }
  ctx.log.debug(`[wake] "${worker.name}" interrupting wait`);
  if (loop) await cancelIfPending(ctx, loop._id);
  // Possibly wait for a debounce window before running
  const delayMs = worker.config.debounceMs ?? DEFAULT_CONFIG.debounceMs;
  await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
  await scheduleLoopRun(ctx, worker, { delayMs });
}

// ── Scheduling the loop ────────────────────────────────────────────────────

/** Re-run the loop after `delayMs`, staying in the running state. */
export async function continueRunning(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  delayMs: number,
  lastWorkTs?: number,
): Promise<void> {
  if (worker.status.kind !== "running") {
    await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
  }
  await scheduleLoopRun(ctx, worker, {
    delayMs,
    lastWorkTs,
  });
}

/**
 * Sleep until `now + timeoutMs`, ignoring pings until `now + debounceMs` and
 * letting them interrupt afterward.
 */
export async function scheduleWaiting(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  timeoutMs: number,
  lastWorkTs?: number,
): Promise<void> {
  await scheduleLoopRun(ctx, worker, {
    delayMs: timeoutMs,
    lastWorkTs,
  });
  await ctx.db.patch("workers", worker._id, { status: { kind: "idle" } });
}

/** Stop looping: mark idle and cancel the monitor. */
export async function goIdle(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  state: Doc<"workerState">,
): Promise<void> {
  await ctx.db.patch("workerState", state._id, {
    generation: state.generation + 1n,
    runnerId: undefined,
  });
  await cancelMonitor(ctx, state);
  await ctx.db.patch("workers", worker._id, { status: { kind: "idle" } });
}

async function scheduleLoopRun(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  opts: { delayMs: number; lastWorkTs?: number },
): Promise<void> {
  const state = await getOrCreateWorkerState(ctx, worker);
  const generation = state.generation + 1n;
  const runnerId = await ctx.scheduler.runAfter(
    opts.delayMs,
    internal.loop.loop,
    { name: worker.name, generation },
  );
  await ctx.db.patch("workerState", state._id, {
    generation,
    runnerId,
    ...(opts.lastWorkTs !== undefined ? { lastWorkTs: opts.lastWorkTs } : {}),
  });

  // await ctx.db.patch("workers", worker._id, { status: worker.status });
  await ensureMonitored(ctx, worker, Date.now() + opts.delayMs);
}

// ── Monitor ────────────────────────────────────────────────────────────────

/**
 * Keep the monitor scheduled ~`monitorLagMs` after the loop's next run. Only
 * reschedules when the monitor is missing or about to fire, so a healthy
 * fast-looping worker pushes it back roughly once a minute rather than every
 * iteration.
 */
export async function ensureMonitored(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  loopRunAtMs: number,
): Promise<void> {
  const state = await ctx.db.get("workerState", worker.stateId);
  if (!state) return;

  const lag = Math.max(
    MONITOR_REFRESH_WITHIN_MS,
    worker.config.monitorLagMs ?? MONITOR_LAG_MS,
  );

  const now = Date.now();
  // If the monitor lag is short, just use half of it.
  const gracePeriod = Math.min(lag / 2, MONITOR_REFRESH_WITHIN_MS);
  const close =
    state.monitorRunAtMs == null || state.monitorRunAtMs <= now + gracePeriod;
  if (state.monitorId && !close) return;

  if (state.monitorId) await cancelIfPending(ctx, state.monitorId);
  const desiredAt = loopRunAtMs + lag;
  const monitorId = await ctx.scheduler.runAt(
    desiredAt,
    internal.monitor.monitor,
    { name: worker.name },
  );
  await ctx.db.patch("workerState", worker.stateId, {
    monitorId,
    monitorRunAtMs: desiredAt,
  });
}

export async function cancelMonitor(
  ctx: MutationCtx,
  state: Doc<"workerState">,
): Promise<void> {
  if (state.monitorId) await cancelIfPending(ctx, state.monitorId);
  if (state.monitorId || state.monitorRunAtMs != null) {
    await ctx.db.patch("workerState", state._id, {
      monitorId: undefined,
      monitorRunAtMs: undefined,
    });
  }
}

async function cancelIfPending(
  ctx: MutationCtx,
  id: Id<"_scheduled_functions">,
): Promise<void> {
  const fn = await ctx.db.system.get("_scheduled_functions", id);
  if (fn && fn.state.kind === "pending") {
    await ctx.scheduler.cancel(id);
  }
}
