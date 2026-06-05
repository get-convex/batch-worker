import { v } from "convex/values";
import { Worker, WorkerResult } from "@convex-dev/worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// One worker instance per component. Use distinct `name`s if you want several
// independent queues backed by the same component.
const worker = new Worker(components.worker);

const BATCH_SIZE = 10;

/**
 * Add an event to the queue. After inserting, we tell the worker to make sure
 * its loop is running — it'll batch up and process everything.
 */
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("events", { value });
    await worker.ensureRunning(ctx, {
      queryArgs: {},
      workQuery: internal.example.getBatch,
      workerMutation: internal.example.processBatch,
    });
  },
});

/**
 * The work query: returns the next batch of events, or `null` when the queue
 * is empty. Its return type lines up with `processBatch`'s args.
 */
export const getBatch = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("events").take(BATCH_SIZE);
    if (events.length === 0) return null;
    return {
      ids: events.map((e) => e._id),
      values: events.map((e) => e.value),
    };
  },
});

/**
 * The worker mutation: processes a batch. It owns cleanup (deleting the rows
 * it processed). Returning `{ runAfter: 0 }` on a full batch tells the loop to
 * keep going immediately rather than waiting.
 */
export const processBatch = internalMutation({
  args: {
    ids: v.array(v.id("events")),
    values: v.array(v.number()),
  },
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
    // Full batch → there's probably more; run again right away.
    if (ids.length === BATCH_SIZE) {
      return {
        runAfter: 0,
      } satisfies WorkerResult<unknown>;
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

export const workerStatus = query({
  args: {},
  handler: async (ctx) => worker.status(ctx),
});
