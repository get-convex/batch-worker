/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { getWorker, getWorkerState } from "./kick.js";

// Dummy function handles. These never get invoked in these tests because we
// don't drive the scheduler here — the loop body is exercised end-to-end by
// the example app's tests.
const QUERY = "function://dummyWorkQuery";
const MUTATION = "function://dummyWorkerMutation";

function ensureRunningArgs(overrides?: Record<string, unknown>) {
  return {
    name: "",
    workQuery: QUERY,
    workerMutation: MUTATION,
    queryArgs: {},
    ...overrides,
  };
}

describe("worker component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1765432101234));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("ensureRunning creates the worker and schedules the loop", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    await t.run(async (ctx) => {
      const worker = await getWorker(ctx, "");
      assert(worker);
      expect(worker.state.kind).toBe("active");
      expect(worker.state.generation).toBe(1n);
      expect(worker.monitorId).toBeDefined();
      expect(worker.workQuery).toBe(QUERY);

      const state = await getWorkerState(ctx, "");
      assert(state);
      expect(state.generation).toBe(1n);
      expect(state.runnerId).toBeDefined();
    });
  });

  test("ensureRunning is a no-op while active", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    const before = await t.run((ctx) => getWorkerState(ctx, ""));
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    const after = await t.run((ctx) => getWorkerState(ctx, ""));
    // No new generation, no new scheduled runner.
    expect(after!.generation).toBe(before!.generation);
    expect(after!.runnerId).toBe(before!.runnerId);
  });

  test("status reflects the run state", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.lib.status, { name: "" })).toBeNull();
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    const status = await t.query(api.lib.status, { name: "" });
    expect(status?.kind).toBe("active");
    expect(status?.generation).toBe(1n);
  });

  test("stop cancels the loop and goes idle", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.run(async (ctx) => {
      const worker = await getWorker(ctx, "");
      expect(worker!.state.kind).toBe("idle");
      expect(worker!.monitorId).toBeUndefined();
      const state = await getWorkerState(ctx, "");
      expect(state!.runnerId).toBeUndefined();
    });
  });

  test("ensureRunning after stop kicks again with a bumped generation", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    const worker = await t.run((ctx) => getWorker(ctx, ""));
    expect(worker!.state.kind).toBe("active");
    expect(worker!.state.generation).toBe(2n);
  });

  test("a superseded loop generation exits without changing state", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    // Generation 0 is stale (current is 1) — the loop should bail immediately,
    // never touching the dummy handles.
    await t.mutation(internal.loop.loop, { name: "", generation: 0n });
    const state = await t.run((ctx) => getWorkerState(ctx, ""));
    expect(state!.generation).toBe(1n);
  });

  test("monitor restarts a dead loop and keeps watching", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    const before = await t.run((ctx) => getWorkerState(ctx, ""));
    // Simulate the loop dying by canceling its scheduled runner.
    await t.run((ctx) => ctx.scheduler.cancel(before!.runnerId!));

    await t.mutation(internal.monitor.monitor, { name: "" });

    const after = await t.run((ctx) => getWorkerState(ctx, ""));
    const worker = await t.run((ctx) => getWorker(ctx, ""));
    expect(after!.generation > before!.generation).toBe(true);
    expect(after!.runnerId).not.toBe(before!.runnerId);
    expect(worker!.state.kind).toBe("active");
    // A successor monitor was scheduled (monitoring continues post-restart).
    expect(worker!.monitorId).toBeDefined();
  });

  test("monitor stops itself once the worker is idle", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs());
    await t.mutation(api.lib.stop, { name: "" });

    await t.mutation(internal.monitor.monitor, { name: "" });

    const worker = await t.run((ctx) => getWorker(ctx, ""));
    expect(worker!.state.kind).toBe("idle");
    expect(worker!.monitorId).toBeUndefined();
  });

  test("independent named workers don't interfere", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs({ name: "a" }));
    await t.mutation(api.lib.ensureRunning, ensureRunningArgs({ name: "b" }));
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe("active");
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe("active");
    await t.mutation(api.lib.stop, { name: "a" });
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe("idle");
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe("active");
  });
});
