import {
  createFunctionHandle,
  type DefaultFunctionArgs,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  type BatchQueryArgs,
  type BatchResult,
  type Config,
  type DefaultCursor,
  type WorkerResult,
} from "../component/shared.js";

export {
  batchValidators,
  vBatchQueryArgs,
  vBatchResult,
  vDefaultCursor,
  vWorkerResult,
  type BatchResult,
  type BatchQueryArgs,
  type DefaultCursor,
  type WorkerResult,
} from "../component/shared.js";
export type {
  Config as WorkerConfig,
  Status as WorkerStatus,
} from "../component/shared.js";

/**
 * Register-or-refresh a worker and make sure its loop is running. Call it right
 * after inserting work. Idempotent and cheap (a no-op while the loop is
 * already running).
 *
 * You provide:
 *  - a **work query** (args validated by {@link vBatchQueryArgs}, returns
 *    {@link vBatchResult}) that returns the next batch or `idle`, and
 *  - a **worker mutation** that processes a batch and owns its cleanup. It may
 *    return `{ debounceMs }` to throttle the loop.
 *
 * The cursor type is taken from the work query's `cursor` arg, so that's the
 * one place to declare it; the return types are checked against it.
 *
 * @example
 * ```ts
 * export const enqueue = mutation({
 *   args: { task: v.string() },
 *   handler: async (ctx, { task }) => {
 *     await ctx.db.insert("tasks", { task });
 *     await ping(ctx, components.batchWorker, {
 *       name: "tasks",
 *       workQuery: internal.tasks.getBatch,
 *       workerMutation: internal.tasks.processBatch,
 *     });
 *   },
 * });
 * ```
 */
export async function ping<
  Batch extends DefaultFunctionArgs,
  Cursor = DefaultCursor,
>(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  args: {
    /** Worker name — also passed to your query as `args.name`. */
    name: string;
    /** Returns the next batch of work, or `idle`. */
    workQuery: FunctionReference<
      "query",
      "internal",
      BatchQueryArgs<Cursor>,
      BatchResult<Batch, NoInfer<Cursor>>
    >;
    /** Processes a batch returned by the work query. */
    workerMutation: FunctionReference<
      "mutation",
      "internal",
      Batch,
      WorkerResult<NoInfer<Cursor>> | void
    >;
    /** Loop configuration. */
    config?: Partial<Config>;
  },
): Promise<void> {
  const [workQuery, workerMutation] = await Promise.all([
    createFunctionHandle(args.workQuery),
    createFunctionHandle(args.workerMutation),
  ]);
  await ctx.runMutation(component.lib.ping, {
    name: args.name,
    workQuery,
    workerMutation,
    config: args.config ?? {},
  });
}

/**
 * Read the cursor the worker last committed, or `null` if it has none yet.
 *
 * Useful when one of your own queries scans the same range the work query
 * does — counting pending work, say — so it starts past the same tombstones.
 *
 * @example
 * ```ts
 * const from = (await getCursor(ctx, components.batchWorker, { name })) ?? 0n;
 * const pending = await ctx.db
 *   .query("tasks")
 *   .withIndex("insertedAt", (q) => q.gte("insertedAt", from))
 *   .take(1000);
 * ```
 */
export async function getCursor<Cursor = DefaultCursor>(
  ctx: QueryCtx | MutationCtx | ActionCtx,
  component: ComponentApi,
  args: { name: string },
): Promise<Cursor | null> {
  return (await ctx.runQuery(component.lib.cursor, args)) as Cursor | null;
}

/**
 * Overwrite the worker's cursor, or clear it (omit `cursor`) so the next scan
 * starts from the front.
 *
 * For migrations and recovery — in the steady state, return a cursor from the
 * work query instead. The loop writes the same document every iteration, so
 * this is liable to conflict if the worker is busy.
 */
export async function setCursor<Cursor = DefaultCursor>(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  args: { name: string; cursor?: Cursor },
): Promise<void> {
  await ctx.runMutation(component.lib.setCursor, args);
}

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;
