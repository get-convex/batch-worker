import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  ensureRunning as ensureRunningHelper,
  getWorker,
  stop as stopHelper,
} from "./kick.js";
import { vConfig, vRunState } from "./shared.js";

/**
 * The public component API. Apps normally call these through the `Worker`
 * client wrapper (see `@convex-dev/worker`) rather than directly.
 */

export const ensureRunning = mutation({
  args: {
    name: v.string(),
    // Function handles, created app-side with `createFunctionHandle`.
    workQuery: v.string(),
    workerMutation: v.string(),
    queryArgs: v.optional(v.any()),
    config: v.optional(vConfig.partial()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ensureRunningHelper(ctx, {
      name: args.name,
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      queryArgs: args.queryArgs,
      config: args.config ?? {},
    });
    return null;
  },
});

export const status = query({
  args: { name: v.string() },
  returns: v.union(v.null(), vRunState),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.name);
    if (!worker) return null;
    return {
      kind: worker.state.kind,
    };
  },
});

export const stop = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await stopHelper(ctx, args.name);
    return null;
  },
});
