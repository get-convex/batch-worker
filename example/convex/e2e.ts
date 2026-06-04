import { v } from "convex/values";
import { Worker } from "@convex-dev/worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Instrumented worker used by e2e.mjs to measure performance. Kept separate
// from the README example (different worker `name`) so it doesn't interfere.
const worker = new Worker(components.worker, { name: "e2e" });

const BATCH_SIZE = 25;

/** Clear all e2e state and stop the worker so each scenario starts cold. */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    for (const table of ["e2eEvents", "e2eSamples"] as const) {
      let docs = await ctx.db.query(table).take(500);
      while (docs.length > 0) {
        for (const d of docs) await ctx.db.delete(table, d._id);
        docs = await ctx.db.query(table).take(500);
      }
    }
    await worker.stop(ctx);
  },
});

/** Insert `count` events in a single transaction, then ensure the worker runs. */
export const enqueue = mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("e2eEvents", { value: 1 });
    }
    await worker.ensureRunning(ctx, {
      workQuery: internal.e2e.getBatch,
      workerMutation: internal.e2e.processBatch,
      queryArgs: {},
    });
  },
});

export const getBatch = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("e2eEvents").take(BATCH_SIZE);
    if (events.length === 0) return null;
    return {
      batch: events.map((e) => ({ id: e._id, creationTime: e._creationTime })),
    };
  },
});

export const processBatch = internalMutation({
  args: {
    batch: v.array(
      v.object({ id: v.id("e2eEvents"), creationTime: v.number() }),
    ),
  },
  handler: async (ctx, { batch }) => {
    const now = Date.now();
    const latencies = batch.map((b) => now - b.creationTime);
    await ctx.db.insert("e2eSamples", {
      processedAt: now,
      batchSize: batch.length,
      oldestLatencyMs: Math.max(...latencies),
      newestLatencyMs: Math.min(...latencies),
    });
    for (const b of batch) {
      await ctx.db.delete("e2eEvents", b.id);
    }
    if (batch.length === BATCH_SIZE) {
      return { runAfter: 0 };
    }
  },
});

export const samples = query({
  args: {},
  handler: async (ctx) => ctx.db.query("e2eSamples").take(100000),
});

export const pending = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("e2eEvents").take(100000)).length,
});

export const status = query({
  args: {},
  handler: async (ctx) => worker.status(ctx),
});
