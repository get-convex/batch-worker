import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vConfig, vRunState } from "./shared.js";

export default defineSchema({
  // One row per named worker. Written rarely — only when the worker is
  // created, reconfigured, or transitions between idle and active. This lets
  // `ensureRunning` read it on every insert without OCC-conflicting with the
  // fast-looping `loop`, which never writes this doc while actively running.
  workers: defineTable({
    name: v.string(),
    // Function handles (created in the app via createFunctionHandle).
    workQuery: v.string(),
    workerMutation: v.string(),
    config: vConfig,
    state: vRunState,
    // The self-rescheduling monitor that restarts the loop if it dies.
    monitorId: v.optional(v.id("_scheduled_functions")),
  }).index("name", ["name"]),

  // One row per named worker, owned and written by `loop` on every iteration.
  // Kept separate from `workers` so its high churn doesn't conflict with
  // `ensureRunning`. Never read by `ensureRunning`.
  workerState: defineTable({
    name: v.string(),
    // Monotonically bumped each iteration & each kick. A scheduled loop whose
    // generation no longer matches has been superseded and exits silently.
    generation: v.int64(),
    // Current args for the work query; advanced by the worker mutation.
    queryArgs: v.any(),
    // When the loop last saw work; drives the cooldown window.
    lastWorkTs: v.number(),
    // Updated each iteration; lets the monitor detect a wedged loop.
    heartbeat: v.number(),
    // The currently-scheduled loop invocation, checked by the monitor.
    runnerId: v.optional(v.id("_scheduled_functions")),
  }).index("name", ["name"]),
});
