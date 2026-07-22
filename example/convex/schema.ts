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

  // --- Rate-limited async LLM batches (see rateLimited.ts) ---
  llmRequests: defineTable({
    prompt: v.string(),
    inputTokens: v.number(),
    state: v.union(
      v.literal("pending"),
      v.literal("started"),
      v.literal("finished"),
    ),
    startedAt: v.optional(v.number()),
    response: v.optional(v.string()),
    outputTokens: v.optional(v.number()),
  }).index("state", ["state"]),

  // --- Serial denormalized-aggregate updates (see aggregates.ts) ---
  scoreEvents: defineTable({ team: v.string(), points: v.number() }),
  teamTotals: defineTable({ team: v.string(), total: v.number() }).index(
    "team",
    ["team"],
  ),

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
