import { v } from "convex/values";
import { ping, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";
import { advanceCursor, cursorFor, cursorThrough } from "./cursor.js";

// Serial processing to update denormalized aggregates without write conflicts.
//
// Every score is inserted cheaply (no contention on insert). One loop folds
// batches of them into per-team totals. Because exactly one loop runs at a
// time, those hot aggregate rows have a single writer — so they never OCC
// against each other or against incoming scores, no matter the rate.

const WORKER = "aggregates";

const BATCH_SIZE = 20;

const worker = {
  name: WORKER,
  workQuery: internal.aggregates.getBatch,
  workerMutation: internal.aggregates.processBatch,
};

/**
 * Record a score. Cheap insert, then ping — the aggregate update happens in the
 * background, so this mutation never contends with other scorers.
 */
export const recordScore = mutation({
  args: { team: v.string(), points: v.number() },
  handler: async (ctx, { team, points }) => {
    // `db.vars.commitTs` resolves to this mutation's commit timestamp, giving
    // the worker something monotonic to cursor through. See cursor.ts.
    await ctx.db.insert("scoreEvents", {
      team,
      points,
      updatedAt: ctx.db.vars.commitTs,
    });
    await ping(ctx, components.batchWorker, worker);
  },
});

const vScoreEvent = v.object({
  id: v.id("scoreEvents"),
  team: v.string(),
  points: v.number(),
});

export const getBatch = internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult(
    v.object({
      events: v.array(vScoreEvent),
      cursor: v.union(v.int64(), v.null()),
    }),
  ),
  handler: async (ctx, { name }) => {
    // Resume from the last batch's commit timestamp instead of scanning the
    // front of the table, which fills with tombstones as we delete. See
    // cursor.ts for why the cursor is inclusive (`gte`).
    const from = await cursorFor(ctx, name);
    const events = await ctx.db
      .query("scoreEvents")
      .withIndex("updatedAt", (q) => q.gte("updatedAt", from))
      .take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        events: events.map((e) => ({
          id: e._id,
          team: e.team,
          points: e.points,
        })),
        // Rows come back in commit order, so the last one is how far we got.
        cursor: cursorThrough(events),
      },
    };
  },
});

export const processBatch = internalMutation({
  args: {
    events: v.array(vScoreEvent),
    cursor: v.union(v.int64(), v.null()),
  },
  handler: async (ctx, { events, cursor }) => {
    // Fold the batch into one delta per team first, so we touch each aggregate
    // row once regardless of how many events it covers.
    const deltas = new Map<string, number>();
    for (const { team, points } of events) {
      deltas.set(team, (deltas.get(team) ?? 0) + points);
    }
    for (const [team, delta] of deltas) {
      const row = await ctx.db
        .query("teamTotals")
        .withIndex("team", (q) => q.eq("team", team))
        .unique();
      if (row) {
        await ctx.db.patch("teamTotals", row._id, { total: row.total + delta });
      } else {
        await ctx.db.insert("teamTotals", { team, total: delta });
      }
    }
    for (const { id } of events) {
      await ctx.db.delete("scoreEvents", id);
    }
    // Only the loop writes the cursor, so this never conflicts with inserts.
    if (cursor !== null) {
      await advanceCursor(ctx, WORKER, cursor);
    }
    // Returning nothing re-runs immediately to drain the rest.
  },
});

export const getTotals = query({
  args: {},
  handler: async (ctx) => {
    const totals = await ctx.db.query("teamTotals").take(100);
    // Scores still queued, waiting to be folded into the aggregates. Reading
    // from the cursor keeps this off the tombstones too.
    const from = await cursorFor(ctx, WORKER);
    const pending = (
      await ctx.db
        .query("scoreEvents")
        .withIndex("updatedAt", (q) => q.gte("updatedAt", from))
        .take(1000)
    ).length;
    return {
      totals: Object.fromEntries(totals.map((t) => [t.team, t.total])),
      pending,
    };
  },
});

// status takes only a `{ name }`, so call it on the component.
export const workerStatus = query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});
