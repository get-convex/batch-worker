import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // A simple work queue: each row is one event to be summed.
  events: defineTable({ value: v.number() }),
  // A singleton holding the running total, updated by the worker.
  totals: defineTable({
    key: v.string(),
    total: v.number(),
    count: v.number(),
  }).index("key", ["key"]),

  // --- e2e performance harness (see e2e.ts / e2e.mjs) ---
  e2eEvents: defineTable({ value: v.number() }),
  // One row per processed batch, recording end-to-end latency.
  e2eSamples: defineTable({
    processedAt: v.number(),
    batchSize: v.number(),
    // ms from each event's enqueue (_creationTime) to when it was processed.
    oldestLatencyMs: v.number(),
    newestLatencyMs: v.number(),
  }),
});
