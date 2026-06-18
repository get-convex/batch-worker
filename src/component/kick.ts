import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { env, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { createLogger } from "./logging.js";
import {
  type Config,
  DEFAULT_CONFIG,
  MONITOR_REFRESH_WITHIN_MS,
  type RunState,
  RUNNING_THRESHOLD_MS,
} from "./shared.js";

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
  ctx: MutationCtx,
  args: {
    name: string;
    workQuery: string;
    workerMutation: string;
    config: Partial<Config>;
  },
): Promise<void> {
  const config: Config = { ...DEFAULT_CONFIG, ...args.config };
  const worker = await getWorker(ctx, args.name);

  if (!worker) {
    await ctx.db.insert("workerState", {
      name: args.name,
      generation: 0n,
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
    await startLoop(ctx, (await ctx.db.get("workers", workerId))!);
    return;
  }

  // Refresh handles/config only while idle — writing them while the loop runs
  // would OCC-conflict with the per-insert read, and a running loop already
  // has what it needs.
  if (worker.state.kind === "idle") {
    await ctx.db.patch("workers", worker._id, {
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      config,
    });
  }
  await wake(ctx, (await ctx.db.get("workers", worker._id))!);
}

/**
 * Resume an existing worker (e.g. after `stop`) using its stored handles and
 * config. No-ops if the worker was never created with `ping`.
 */
export async function start(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  await wake(ctx, worker);
}

/**
 * Stop the worker: cancel its loop and monitor and mark it idle. `start` or
 * `ping` will resume it.
 */
export async function stop(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  const state = await getWorkerState(ctx, name);
  if (state?.runnerId) {
    await cancelIfPending(ctx, state.runnerId);
    await ctx.db.patch("workerState", state._id, { runnerId: undefined });
  }
  await cancelMonitor(ctx, worker);
  await ctx.db.patch("workers", worker._id, { state: { kind: "idle" } });
}

// ── Waking the loop ────────────────────────────────────────────────────────

/**
 * Decide whether a ping/start should do anything:
 * - idle    → start a fresh loop.
 * - running → no-op (work will be picked up imminently).
 * - waiting → suppressed during the debounce window; otherwise interrupt and
 *   run now (unless the loop is already about to run).
 */
async function wake(ctx: MutationCtx, worker: Doc<"workers">): Promise<void> {
  const console = createLogger(env.LOG_LEVEL);
  const state = worker.state;
  if (state.kind === "idle") {
    await startLoop(ctx, worker);
    return;
  }
  if (state.kind === "running") {
    console.debug(`[wake] "${worker.name}" running — no-op`);
    return;
  }
  const now = Date.now();
  if (now < state.debounceUntilMs) {
    console.debug(`[wake] "${worker.name}" within debounce — no-op`);
    return;
  }
  if (now >= state.runAtMs) {
    console.debug(`[wake] "${worker.name}" about to run — no-op`);
    return;
  }
  // Interrupt the wait and run now.
  const ws = await getWorkerState(ctx, worker.name);
  if (ws?.runnerId) await cancelIfPending(ctx, ws.runnerId);
  console.debug(`[wake] "${worker.name}" interrupting wait`);
  await startLoop(ctx, worker, 0);
}

// ── Scheduling the loop ────────────────────────────────────────────────────

/**
 * Start a fresh loop chain. Used by ping/start (debounced), the monitor
 * (restart), and ping interrupts (delayMs = 0).
 */
export async function startLoop(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  delayMs: number = worker.config.debounceMs,
): Promise<void> {
  const now = Date.now();
  const runState: RunState =
    delayMs <= RUNNING_THRESHOLD_MS
      ? { kind: "running" }
      : { kind: "waiting", runAtMs: now + delayMs, debounceUntilMs: now };
  await scheduleLoopRun(ctx, worker, { delayMs, runState });
}

/** Re-run the loop after `delayMs`, staying in the (ping-no-op) running state. */
export async function continueRunning(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  delayMs: number,
  lastWorkTs?: number,
): Promise<void> {
  await scheduleLoopRun(ctx, worker, {
    delayMs,
    runState: { kind: "running" },
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
  debounceMs: number,
  timeoutMs: number,
  lastWorkTs?: number,
): Promise<void> {
  const now = Date.now();
  await scheduleLoopRun(ctx, worker, {
    delayMs: timeoutMs,
    runState: {
      kind: "waiting",
      runAtMs: now + timeoutMs,
      debounceUntilMs: now + debounceMs,
    },
    lastWorkTs,
  });
}

/** Stop looping: mark idle and cancel the monitor. */
export async function goIdle(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  state: Doc<"workerState">,
): Promise<void> {
  await ctx.db.patch("workerState", state._id, {
    heartbeat: Date.now(),
    runnerId: undefined,
  });
  await cancelMonitor(ctx, worker);
  await ctx.db.patch("workers", worker._id, { state: { kind: "idle" } });
}

async function scheduleLoopRun(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  opts: { delayMs: number; runState: RunState; lastWorkTs?: number },
): Promise<void> {
  const state = (await getWorkerState(ctx, worker.name))!;
  const generation = state.generation + 1n;
  const runnerId = await ctx.scheduler.runAfter(
    opts.delayMs,
    internal.loop.loop,
    { name: worker.name, generation },
  );
  await ctx.db.patch("workerState", state._id, {
    generation,
    runnerId,
    heartbeat: Date.now(),
    ...(opts.lastWorkTs !== undefined ? { lastWorkTs: opts.lastWorkTs } : {}),
  });
  await setRunState(ctx, worker, opts.runState);
  await ensureMonitorBehind(ctx, worker._id, Date.now() + opts.delayMs);
}

/** Patch `workers.state` only when it actually changed, to avoid churn. */
async function setRunState(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  next: RunState,
): Promise<void> {
  const cur = worker.state;
  const unchanged =
    cur.kind === next.kind &&
    (next.kind !== "waiting" ||
      (cur.kind === "waiting" &&
        cur.runAtMs === next.runAtMs &&
        cur.debounceUntilMs === next.debounceUntilMs));
  if (!unchanged) {
    await ctx.db.patch("workers", worker._id, { state: next });
  }
}

// ── Monitor ────────────────────────────────────────────────────────────────

/**
 * Keep the monitor scheduled ~`monitorLagMs` after the loop's next run. Only
 * reschedules when the monitor is missing or about to fire, so a healthy
 * fast-looping worker pushes it back roughly once a minute rather than every
 * iteration.
 */
export async function ensureMonitorBehind(
  ctx: MutationCtx,
  workerId: Id<"workers">,
  loopRunAtMs: number,
): Promise<void> {
  const worker = (await ctx.db.get("workers", workerId))!;
  const now = Date.now();
  const close =
    worker.monitorRunAtMs == null ||
    worker.monitorRunAtMs <= now + MONITOR_REFRESH_WITHIN_MS;
  if (worker.monitorId && !close) return;

  if (worker.monitorId) await cancelIfPending(ctx, worker.monitorId);
  const desiredAt = loopRunAtMs + worker.config.monitorLagMs;
  const monitorId = await ctx.scheduler.runAfter(
    Math.max(0, desiredAt - now),
    internal.monitor.monitor,
    { name: worker.name },
  );
  await ctx.db.patch("workers", workerId, {
    monitorId,
    monitorRunAtMs: desiredAt,
  });
}

export async function cancelMonitor(
  ctx: MutationCtx,
  worker: Doc<"workers">,
): Promise<void> {
  if (worker.monitorId) await cancelIfPending(ctx, worker.monitorId);
  if (worker.monitorId || worker.monitorRunAtMs != null) {
    await ctx.db.patch("workers", worker._id, {
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
