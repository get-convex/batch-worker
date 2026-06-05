import {
  createFunctionHandle,
  type DefaultFunctionArgs,
  type FunctionReference,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  type Config as WorkerConfig,
  type RunState as WorkerStatus,
} from "../component/shared.js";

export { logLevel as vLogLevel, type LogLevel } from "../component/logging.js";
export type { WorkerConfig, WorkerStatus };

/**
 * What a worker mutation may return to steer the loop.
 *
 * @typeParam QueryArgs - the args type of your work query.
 */
export type WorkerResult<QueryArgs> = {
  /**
   * Delay in ms before the loop runs again. Defaults to running immediately
   * (there may be more work). Return a larger value to back off, e.g. when
   * you hit a rate limit.
   */
  runAfter?: number;
  /**
   * Updated args for the next call to your work query — e.g. to advance a
   * cursor. Persists across iterations until changed again.
   */
  queryArgs?: QueryArgs;
} | null | void;

/**
 * A handle to a context object that can run mutations.
 */
export type RunMutationCtx = {
  runMutation: <Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    args: Mutation["_args"],
  ) => Promise<Mutation["_returnType"]>;
};
export type RunQueryCtx = {
  runQuery: <Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: Query["_args"],
  ) => Promise<Query["_returnType"]>;
};

export type WorkerComponent = ComponentApi;

export type WorkerOptions = {
  /**
   * Default name/key for this worker. Use distinct names for independent
   * queues backed by the same component. Defaults to "".
   */
  name?: string;
  /**
   * Default loop configuration, overridable per `ensureRunning` call.
   */
  config?: Partial<WorkerConfig>;
};

/**
 * Drives a "main loop" over work you insert into your own table.
 *
 * You provide:
 *  - a **work query** that returns the next batch of work (or `null` when the
 *    queue is empty). Its return type must match the worker mutation's args.
 *  - a **worker mutation** that processes that batch. It owns cleanup (e.g.
 *    deleting the rows it processed) and may return a {@link WorkerResult} to
 *    advance a cursor or back off.
 *
 * After inserting work, call {@link Worker.ensureRunning}. The component runs
 * the loop, debounces bursts, polls during a cooldown window, and restarts the
 * loop if it dies — all without you scheduling anything yourself.
 *
 * @example
 * ```ts
 * const worker = new Worker(components.worker);
 *
 * export const enqueue = mutation({
 *   args: { task: v.string() },
 *   handler: async (ctx, { task }) => {
 *     await ctx.db.insert("tasks", { task });
 *     await worker.ensureRunning(ctx, {
 *       workQuery: internal.tasks.getBatch,
 *       workerMutation: internal.tasks.processBatch,
 *       queryArgs: {},
 *     });
 *   },
 * });
 * ```
 */
export class Worker {
  constructor(
    public component: WorkerComponent,
    public options: WorkerOptions = {},
  ) {}

  /**
   * Make sure the worker's loop is running. Idempotent and cheap to call on
   * every insert: when the loop is already active it does no writes.
   */
  async ensureRunning<
    QueryArgs extends DefaultFunctionArgs,
    Work extends DefaultFunctionArgs,
  >(
    ctx: RunMutationCtx,
    args: {
      /** Returns the next batch of work, or `null` when there's nothing to do. */
      workQuery: FunctionReference<"query", "internal", QueryArgs, Work | null>;
      /** Processes a batch returned by the work query. */
      workerMutation: FunctionReference<
        "mutation",
        "internal",
        Work,
        WorkerResult<QueryArgs>
      >;
      /** Initial args for the work query (advanced via the mutation's result). */
      queryArgs: QueryArgs;
      /** Worker name; defaults to the instance's configured name. */
      name?: string;
      /** Per-call config overrides. */
      config?: Partial<WorkerConfig>;
    },
  ): Promise<void> {
    const [workQuery, workerMutation] = await Promise.all([
      createFunctionHandle(args.workQuery),
      createFunctionHandle(args.workerMutation),
    ]);
    await ctx.runMutation(this.component.lib.ensureRunning, {
      name: this.nameFor(args.name),
      workQuery,
      workerMutation,
      queryArgs: args.queryArgs,
      config: { ...this.options.config, ...args.config },
    });
  }

  /** Get the current run status of the worker, or `null` if it's never run. */
  async status(ctx: RunQueryCtx, name?: string): Promise<WorkerStatus | null> {
    return ctx.runQuery(this.component.lib.status, {
      name: this.nameFor(name),
    });
  }

  private nameFor(name?: string): string {
    return name ?? this.options.name ?? "";
  }
}
