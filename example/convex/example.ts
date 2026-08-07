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
    // `db.vars.commitTs` resolves to this mutation's commit timestamp. Every row
    // a mutation writes shares one value, and nothing can commit later with a
    // smaller one — that's what makes it safe to cursor on. See cursor.ts.
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
  returns: vBatchResult({ events: v.array(vEvent) }),
  handler: async (ctx, { cursor }) => {
    // Pick up where the last batch stopped, rather than from the front of the
    // table — where every row we've already deleted leaves a tombstone to scan
    // over. `gte` because the cursor is inclusive: everything one mutation
    // inserts shares a commit timestamp, and a batch can end mid-tie.
    const events = await ctx.db
      .query("events")
      .withIndex("insertedAt", (q) => q.gte("insertedAt", cursor ?? 0n))
      .take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: { events: events.map((e) => ({ id: e._id, value: e.value })) },
      // Rows come back in commit order, so the last one is how far we got.
      // The component commits this with the batch and hands it back above.
      cursor: events.at(-1)!.insertedAt,
    };
  },
});

/**
 * The worker mutation: processes a batch. It owns cleanup — deleting the rows
 * it processed so the table stays small. The cursor isn't its problem.
 * Returning nothing re-runs immediately to drain the rest.
 */
export const processBatch = internalMutation({
  args: { events: v.array(vEvent) },
  handler: async (ctx, { events }) => {
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
    // from the worker's cursor keeps this off the tombstones too.
    const from = ((await ctx.runQuery(components.batchWorker.lib.cursor, {
      name: WORKER,
    })) ?? 0n) as bigint;
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
