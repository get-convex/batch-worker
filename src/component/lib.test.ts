/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { assert, describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { getWorker } from "./kick.js";

// Dummy function handles. The loop body is never driven here: it relies on
// retry-on-change (`requestRetry`), which convex-test doesn't support yet. These
// tests cover only the plain ping/start/stop/status state machine — the loop is
// exercised end-to-end by the example app against a real backend.
const QUERY = "function://dummyWorkQuery";
const MUTATION = "function://dummyWorkerMutation";

function pingArgs(overrides?: Record<string, unknown>) {
  return { name: "", workQuery: QUERY, workerMutation: MUTATION, ...overrides };
}

// Count the pending scheduled `loop` invocations for a worker.
async function scheduledLoops(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.state.kind === "pending").length;
  });
}

describe("worker component", () => {
  test("ping creates the worker and schedules the loop", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    const worker = await t.run((ctx) => getWorker(ctx, ""));
    assert(worker);
    expect(worker.status.kind).toBe("running");
    expect(worker.workQuery).toBe(QUERY);
    expect(await scheduledLoops(t)).toBe(1);
  });

  test("status reflects the run state", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.lib.status, { name: "" })).toBeNull();
    await t.mutation(api.lib.ping, pingArgs());
    expect((await t.query(api.lib.status, { name: "" }))?.kind).toBe("running");
  });

  test("ping is a no-op while running (no duplicate loop)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.ping, pingArgs());
    // Still exactly one scheduled loop — the second ping didn't spawn another.
    expect(await scheduledLoops(t)).toBe(1);
  });

  test("stop marks the worker stopped", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    expect((await t.query(api.lib.status, { name: "" }))?.kind).toBe("stopped");
  });

  test("start resumes a stopped worker and reschedules the loop", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.mutation(api.lib.start, { name: "" });
    expect((await t.query(api.lib.status, { name: "" }))?.kind).toBe("running");
    // Both the create and the start scheduled a loop.
    expect(await scheduledLoops(t)).toBe(2);
  });

  test("start is a no-op for an unknown worker", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.start, { name: "ghost" });
    expect(await t.query(api.lib.status, { name: "ghost" })).toBeNull();
  });

  test("start is a no-op while already running", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.start, { name: "" });
    // start didn't schedule a second loop over the running worker.
    expect(await scheduledLoops(t)).toBe(1);
  });

  test("ping is ignored while stopped (only start resumes)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.mutation(api.lib.ping, pingArgs());
    expect((await t.query(api.lib.status, { name: "" }))?.kind).toBe("stopped");
  });

  test("independent named workers don't interfere", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs({ name: "a" }));
    await t.mutation(api.lib.ping, pingArgs({ name: "b" }));
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe("running");
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe("running");
    await t.mutation(api.lib.stop, { name: "a" });
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe("stopped");
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe("running");
  });
});
