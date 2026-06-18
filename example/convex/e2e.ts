import { v } from "convex/values";
import {
  BatchWorker,
  vBatchQueryArgs,
  vBatchResult,
} from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Instrumented worker used by e2e.mjs to measure performance. Kept separate
// from the README example (different worker `name`) so it doesn't interfere.
const worker = new BatchWorker(components.batchWorker, { name: "e2e" });

const BATCH_SIZE = 25;

/**
 * Clear all e2e state between scenarios. We don't `stop` the worker — it drains
 * to idle on its own, and the next `enqueue` (a ping) resumes it. (`stop` would
 * leave it `stopped`, which only `start` — not `ping` — resumes.)
 */
export const reset = mutation({
  args: {},
  handler: async (ctx) => {
    for (const table of ["e2eEvents", "e2eSamples"] as const) {
      const docs = await ctx.db.query(table).collect();
      for (const d of docs) await ctx.db.delete(table, d._id);
    }
  },
});

/** Insert `count` events in a single transaction, then ensure the worker runs. */
export const enqueue = mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("e2eEvents", { value: 1 });
    }
    await worker.ping(ctx, {
      workQuery: internal.e2e.getBatch,
      workerMutation: internal.e2e.processBatch,
    });
  },
});

export const getBatch = internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult(
    v.object({
      items: v.array(
        v.object({ id: v.id("e2eEvents"), creationTime: v.number() }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const events = await ctx.db.query("e2eEvents").take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        items: events.map((e) => ({
          id: e._id,
          creationTime: e._creationTime,
        })),
      },
    };
  },
});

export const processBatch = internalMutation({
  args: {
    items: v.array(
      v.object({ id: v.id("e2eEvents"), creationTime: v.number() }),
    ),
  },
  handler: async (ctx, { items }) => {
    const now = Date.now();
    const latencies = items.map((b) => now - b.creationTime);
    await ctx.db.insert("e2eSamples", {
      processedAt: now,
      batchSize: items.length,
      oldestLatencyMs: Math.max(...latencies),
      newestLatencyMs: Math.min(...latencies),
    });
    for (const b of items) {
      await ctx.db.delete("e2eEvents", b.id);
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

export const start = mutation({
  args: {},
  handler: async (ctx) => worker.start(ctx),
});

export const stop = mutation({
  args: {},
  handler: async (ctx) => worker.stop(ctx),
});
