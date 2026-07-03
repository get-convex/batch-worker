import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { env, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { createLogger } from "./logging.js";
import { type Config, DEFAULT_CONFIG } from "./shared.js";

export async function getWorker(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("workers")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
}

// ── Public entry points (ping / start / stop) ──────────────────────────────

/**
 * Register-or-refresh a worker and make sure its loop is live. Carries the work
 * query/mutation + config; creates the worker (and schedules its loop) on first
 * call. Call it once after the *first* insert — while the loop is already
 * running, inserting work wakes the suspended loop reactively, so you don't
 * need to ping again.
 *
 * Cheap and OCC-friendly: when the loop is already running it only reads (and
 * at most refreshes the handles/config on) the `workers` doc.
 */
export async function ping(
  ctx: MutationCtx,
  args: {
    name: string;
    workQuery: string;
    workerMutation: string;
    config?: Partial<Config> | undefined;
  },
): Promise<void> {
  const worker = await getWorker(ctx, args.name);

  if (!worker) {
    const workerId = await ctx.db.insert("workers", {
      name: args.name,
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      config: args.config ?? {},
      status: { kind: "running" },
    });
    const worker = (await ctx.db.get("workers", workerId))!;
    const delayMs = args.config?.debounceMs ?? DEFAULT_CONFIG.debounceMs;
    await scheduleLoop(ctx, worker, delayMs);
    return;
  }

  await refreshHandles(ctx, worker, args);

  // A running worker is already live (scheduled, executing, or suspended) — a
  // reactive wake picks up new work. A stopped worker only resumes via `start`.
  const console = createLogger(env.LOG_LEVEL);
  console.debug(`[ping] "${worker.name}" ${worker.status.kind} — no-op`);
}

/**
 * Resume a stopped worker using its stored handles and config. No-ops if the
 * worker was never created or is already running.
 */
export async function start(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  if (worker.status.kind !== "stopped") {
    const console = createLogger(env.LOG_LEVEL);
    console.debug(`[start] "${worker.name}" ${worker.status.kind} — no-op`);
    return;
  }
  await ctx.db.patch("workers", worker._id, { status: { kind: "running" } });
  const delayMs = worker.config.debounceMs ?? DEFAULT_CONFIG.debounceMs;
  await scheduleLoop(ctx, worker, delayMs);
}

/**
 * Stop the worker: mark it `stopped`. A scheduled loop sees this on its next run
 * and exits; a suspended loop wakes (its read set includes this doc) and exits
 * — either way it releases without rescheduling. Only `start` resumes it.
 */
export async function stop(ctx: MutationCtx, name: string): Promise<void> {
  const worker = await getWorker(ctx, name);
  if (!worker) return;
  await ctx.db.patch("workers", worker._id, { status: { kind: "stopped" } });
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Refresh the stored handles/config if the ping carries new ones. */
async function refreshHandles(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  args: {
    workQuery: string;
    workerMutation: string;
    config?: Partial<Config> | undefined;
  },
): Promise<void> {
  if (
    args.workQuery !== worker.workQuery ||
    args.workerMutation !== worker.workerMutation ||
    (args.config &&
      (args.config.debounceMs !== worker.config.debounceMs ||
        args.config.retryBackoffMs !== worker.config.retryBackoffMs))
  ) {
    worker.workQuery = args.workQuery;
    worker.workerMutation = args.workerMutation;
    if (args.config) worker.config = args.config;
    await ctx.db.replace("workers", worker._id, worker);
  }
}

/** Schedule the loop to run after `delayMs`. */
export async function scheduleLoop(
  ctx: MutationCtx,
  worker: Doc<"workers">,
  delayMs: number,
): Promise<void> {
  await ctx.scheduler.runAfter(delayMs, internal.loop.loop, {
    name: worker.name,
  });
}
