import {
  createFunctionHandle,
  type DefaultFunctionArgs,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  type BatchQueryArgs,
  type BatchResult,
  type ConfigOverrides,
  normalizeConfig,
  type WorkerResult,
} from "../component/shared.js";

export {
  vBatchQueryArgs,
  vBatchResult,
  vWorkerResult,
  type BatchResult,
  type BatchQueryArgs,
  type ConfigOverrides,
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
export async function ping<Batch extends DefaultFunctionArgs>(
  ctx: MutationCtx | ActionCtx,
  component: ComponentApi,
  args: {
    /** Worker name — also passed to your query as `args.name`. */
    name: string;
    /** Returns the next batch of work, or `idle`. */
    workQuery: FunctionReference<
      "query",
      "internal",
      BatchQueryArgs,
      BatchResult<Batch>
    >;
    /** Processes a batch returned by the work query. */
    workerMutation: FunctionReference<
      "mutation",
      "internal",
      Batch,
      WorkerResult | void
    >;
    /** Loop configuration. */
    config?: ConfigOverrides | undefined;
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
    config: normalizeConfig(args.config),
  });
}

type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;
