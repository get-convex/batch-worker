import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  getWorker,
  getWorkerState,
  ping as pingHelper,
  start as startHelper,
  stop as stopHelper,
} from "./kick.js";
import { vConfig, vStatus } from "./shared.js";

/**
 * The public component API. Apps normally call these through the `BatchWorker`
 * client wrapper (see `@convex-dev/batch-worker`) rather than directly.
 */

export const ping = mutation({
  args: {
    name: v.string(),
    // Function handles, created app-side with `createFunctionHandle`.
    workQuery: v.string(),
    workerMutation: v.string(),
    config: v.optional(vConfig.partial()),
  },
  returns: v.null(),
  handler: async (ctx, args) =>
    pingHelper(ctx, {
      name: args.name,
      workQuery: args.workQuery,
      workerMutation: args.workerMutation,
      config: args.config ?? {},
    }),
});

export const start = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => startHelper(ctx, args.name),
});

export const stop = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => stopHelper(ctx, args.name),
});

export const status = query({
  args: { name: v.string() },
  returns: v.union(v.null(), vStatus),
  handler: async (ctx, args) => {
    const worker = await getWorker(ctx, args.name);
    if (!worker) return null;
    const state = await getWorkerState(ctx, args.name);
    return {
      kind: worker.state.kind,
      generation: state?.generation ?? 0n,
      lastWorkTs: state?.lastWorkTs ?? 0,
      heartbeat: state?.heartbeat ?? 0,
    };
  },
});
