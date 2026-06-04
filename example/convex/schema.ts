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
});
