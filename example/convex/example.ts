import { v } from "convex/values";
import { ping, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Use distinct `name`s if you want several independent queues backed by the
// same component.
const WORKER = "events";

const BATCH_SIZE = 10;

/**
 * Add an event to the queue. After inserting, ping the worker so its loop runs
 * — it'll batch up and process everything.
 */
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("events", { value });
    await ping(ctx, components.batchWorker, {
      name: WORKER,
      workQuery: internal.example.getBatch,
      workerMutation: internal.example.processBatch,
    });
  },
});

/**
 * The work query: returns the next batch of work, or `idle` when the queue is
 * empty. Its `batch` shape lines up with `processBatch`'s args.
 */
export const getBatch = internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult(
    v.object({ ids: v.array(v.id("events")), values: v.array(v.number()) }),
  ),
  handler: async (ctx) => {
    const events = await ctx.db.query("events").take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        ids: events.map((e) => e._id),
        values: events.map((e) => e.value),
      },
    };
  },
});

/**
 * The worker mutation: processes a batch. It owns cleanup (deleting the rows it
 * processed). Returning nothing re-runs immediately to drain the rest.
 */
export const processBatch = internalMutation({
  args: { ids: v.array(v.id("events")), values: v.array(v.number()) },
  handler: async (ctx, { ids, values }) => {
    const sum = values.reduce((a, b) => a + b, 0);
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    if (totals) {
      await ctx.db.patch("totals", totals._id, {
        total: totals.total + sum,
        count: totals.count + ids.length,
      });
    } else {
      await ctx.db.insert("totals", {
        key: "all",
        total: sum,
        count: ids.length,
      });
    }
    for (const id of ids) {
      await ctx.db.delete("events", id);
    }
  },
});

export const getTotals = query({
  args: {},
  handler: async (ctx) => {
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    return {
      total: totals?.total ?? 0,
      count: totals?.count ?? 0,
    };
  },
});

// start/stop/status take only a `{ name }`, so call them on the component.
export const workerStatus = query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});
