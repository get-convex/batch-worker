import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vConfig, vStatus } from "./shared.js";

export default defineSchema({
  // One row per named worker. The loop reads it every iteration (for the
  // handles + status) and it's written only on create/reconfigure and
  // run-state transitions (start/stop). The loop itself never writes it, so a
  // live loop reading it doesn't OCC-conflict with the rare `ping`/`start`
  // writes.
  workers: defineTable({
    name: v.string(),
    // Function handles (created in the app via createFunctionHandle).
    workQuery: v.string(),
    workerMutation: v.string(),
    config: vConfig.partial(),
    status: vStatus,
  }).index("name", ["name"]),
});
