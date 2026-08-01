import { v } from "convex/values";
import { ping, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { advanceCursor, cursorFor } from "./cursor.js";

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
    // `db.vars.commitTs` resolves to this mutation's commit timestamp, giving
    // the worker something monotonic to cursor through. See cursor.ts.
    await ctx.db.insert("events", { value, insertedAt: ctx.db.vars.commitTs });
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
const vEvent = v.object({ id: v.id("events"), value: v.number() });

export const getBatch = internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult({
    events: v.array(vEvent),
    cursor: v.int64(),
  }),
  handler: async (ctx, { name }) => {
    // Pick up where the last batch stopped, rather than from the front of the
    // table — where every row we've already deleted leaves a tombstone to scan
    // over. `gte` because the cursor is inclusive (see cursor.ts).
    const from = await cursorFor(ctx, name);
    const events = await ctx.db
      .query("events")
      .withIndex("insertedAt", (q) => q.gte("insertedAt", from))
      .take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        events: events.map((e) => ({ id: e._id, value: e.value })),
        // Rows come back in commit order, so the last one is how far we got.
        cursor: events.at(-1)!.insertedAt as bigint,
      },
    };
  },
});

/**
 * The worker mutation: processes a batch. It owns cleanup — advancing the cursor
 * past what it processed, and deleting those rows so the table stays small.
 * Returning nothing re-runs immediately to drain the rest.
 */
export const processBatch = internalMutation({
  args: { events: v.array(vEvent), cursor: v.int64() },
  handler: async (ctx, { events, cursor }) => {
    const sum = events.reduce((a, e) => a + e.value, 0);
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    if (totals) {
      await ctx.db.patch("totals", totals._id, {
        total: totals.total + sum,
        count: totals.count + events.length,
      });
    } else {
      await ctx.db.insert("totals", {
        key: "all",
        total: sum,
        count: events.length,
      });
    }
    for (const { id } of events) {
      await ctx.db.delete("events", id);
    }
    // Only the loop writes the cursor, so this never conflicts with inserts.
    await advanceCursor(ctx, WORKER, cursor);
  },
});

export const getTotals = query({
  args: {},
  handler: async (ctx) => {
    const totals = await ctx.db
      .query("totals")
      .withIndex("key", (q) => q.eq("key", "all"))
      .unique();
    // Events left in the queue waiting for the worker to pick them up. Reading
    // from the cursor keeps this off the tombstones too.
    const from = await cursorFor(ctx, WORKER);
    const pending = (
      await ctx.db
        .query("events")
        .withIndex("insertedAt", (q) => q.gte("insertedAt", from))
        .take(1000)
    ).length;
    return {
      total: totals?.total ?? 0,
      count: totals?.count ?? 0,
      pending,
    };
  },
});

// start/stop/status take only a `{ name }`, so call them on the component.
export const workerStatus = query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});
