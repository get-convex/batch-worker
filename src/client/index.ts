import {
  createFunctionHandle,
  type DefaultFunctionArgs,
  type FunctionReference,
} from "convex/server";
import type { Infer } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  type Config,
  type Status,
  vBatchQueryArgs,
} from "../component/shared.js";

export {
  vBatchQueryArgs,
  vBatchResult,
  vWorkerResult,
  type BatchQueryArgs,
  type WorkerResult,
} from "../component/shared.js";
export type { Config as WorkerConfig, Status as WorkerStatus };

/** The args every work query receives — today just the worker's `name`. */
export type QueryArgs = Infer<typeof vBatchQueryArgs>;

/**
 * What a work query returns: a `batch` of work to process, or `idle` with an
 * optional `timeoutMs` hint for when to look again.
 *
 * @typeParam Batch - the shape passed to your worker mutation.
 */
export type BatchResult<Batch> =
  | { kind: "work"; batch: Batch }
  | { kind: "idle"; timeoutMs?: number };

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
  /** Default loop configuration, overridable per `ping` call. */
  config?: Partial<Config>;
};

/**
 * Drives a "main loop" over work you insert into your own table.
 *
 * You provide:
 *  - a **work query** (args validated by {@link vBatchQueryArgs}, returns
 *    {@link vBatchResult}) that returns the next batch or `idle`, and
 *  - a **worker mutation** that processes a batch and owns its cleanup. It may
 *    return `{ debounceMs, timeoutMs }` to throttle the loop.
 *
 * After inserting work, call {@link BatchWorker.ping}. The component runs the loop,
 * debounces bursts, sleeps until the next due item, and restarts the loop if it
 * dies — without you scheduling anything.
 *
 * @example
 * ```ts
 * const worker = new BatchWorker(components.batchWorker);
 *
 * export const enqueue = mutation({
 *   args: { task: v.string() },
 *   handler: async (ctx, { task }) => {
 *     await ctx.db.insert("tasks", { task });
 *     await worker.ping(ctx, {
 *       workQuery: internal.tasks.getBatch,
 *       workerMutation: internal.tasks.processBatch,
 *     });
 *   },
 * });
 * ```
 */
export class BatchWorker {
  constructor(
    public component: WorkerComponent,
    public options: WorkerOptions = {},
  ) {}

  /**
   * Register-or-refresh the worker and make sure its loop is running. Carries
   * the work query/mutation. Idempotent and cheap to call on every insert.
   */
  async ping<Batch extends DefaultFunctionArgs>(
    ctx: RunMutationCtx,
    args: {
      /** Returns the next batch of work, or `idle`. */
      workQuery: FunctionReference<
        "query",
        "internal",
        QueryArgs,
        BatchResult<Batch>
      >;
      /** Processes a batch returned by the work query. */
      workerMutation: FunctionReference<
        "mutation",
        "internal",
        Batch,
        { debounceMs?: number; timeoutMs?: number } | null | void
      >;
      /** Worker name; defaults to the instance's configured name. */
      name?: string;
      /** Per-call config overrides. */
      config?: Partial<Config>;
    },
  ): Promise<void> {
    const [workQuery, workerMutation] = await Promise.all([
      createFunctionHandle(args.workQuery),
      createFunctionHandle(args.workerMutation),
    ]);
    await ctx.runMutation(this.component.lib.ping, {
      name: this.nameFor(args.name),
      workQuery,
      workerMutation,
      config: { ...this.options.config, ...args.config },
    });
  }

  /**
   * Resume an existing worker (e.g. after {@link BatchWorker.stop}) using its stored
   * query/mutation and config. No-op if it was never `ping`ed.
   */
  async start(ctx: RunMutationCtx, name?: string): Promise<void> {
    await ctx.runMutation(this.component.lib.start, {
      name: this.nameFor(name),
    });
  }

  /** Stop the worker's loop and monitor. `start`/`ping` resumes it. */
  async stop(ctx: RunMutationCtx, name?: string): Promise<void> {
    await ctx.runMutation(this.component.lib.stop, {
      name: this.nameFor(name),
    });
  }

  /** Get the current run status of the worker, or `null` if it's never run. */
  async status(ctx: RunQueryCtx, name?: string): Promise<Status | null> {
    return ctx.runQuery(this.component.lib.status, {
      name: this.nameFor(name),
    });
  }

  private nameFor(name?: string): string {
    return name ?? this.options.name ?? "";
  }
}
