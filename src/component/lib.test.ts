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
import { getWorker, getOrCreateWorkerState, scheduleWaiting } from "./kick.js";
import { RUNNING_THRESHOLD_MS } from "./shared.js";

// Dummy function handles. These never get invoked in these tests because we
// don't drive the scheduler here — the loop body is exercised end-to-end by
// the example app's tests.
const QUERY = "function://dummyWorkQuery";
const MUTATION = "function://dummyWorkerMutation";

function pingArgs(overrides?: Record<string, unknown>) {
  return { name: "", workQuery: QUERY, workerMutation: MUTATION, ...overrides };
}

describe("worker component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1765432101234));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("ping creates the worker and schedules the loop", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.run(async (ctx) => {
      const worker = await getWorker(ctx, "");
      assert(worker);

      expect(worker.status.kind).toBe("running");
      expect(worker.workQuery).toBe(QUERY);

      const state = await getOrCreateWorkerState(ctx, worker);
      expect(state.monitorId).toBeDefined();
      expect(state.monitorRunAtMs).toBeDefined();
      expect(state.generation).toBe(1n);
      expect(state.runnerId).toBeDefined();
    });
  });

  test("monitor is scheduled well after the loop", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.run(async (ctx) => {
      const worker = await getWorker(ctx, "");
      assert(worker);
      const state = await getOrCreateWorkerState(ctx, worker);
      assert(state.monitorRunAtMs);
      // loop runs ~debounceMs out; monitor ~monitorLagMs (60s) beyond that.
      expect(state.monitorRunAtMs).toBeGreaterThan(Date.now() + 50_000);
    });
  });

  test("ping is a no-op while running", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    const before = await t.run(async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    await t.mutation(api.lib.ping, pingArgs());
    const after = await t.run(async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    expect(after!.generation).toBe(before!.generation);
    expect(after!.runnerId).toBe(before!.runnerId);
  });

  test("status reflects the run state", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.lib.status, { name: "" })).toBeNull();
    await t.mutation(api.lib.ping, pingArgs());
    const status = await t.query(api.lib.status, { name: "" });
    expect(status?.kind).toBe("running");
  });

  test("stop cancels the loop and goes stopped", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.run(async (ctx) => {
      const worker = await getWorker(ctx, "");
      assert(worker);
      expect(worker!.status.kind).toBe("stopped");

      const state = await getOrCreateWorkerState(ctx, worker);
      expect(state!.monitorId).toBeUndefined();
      expect(state!.runnerId).toBeUndefined();
    });
  });

  test("start resumes an existing worker after stop", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.mutation(api.lib.start, { name: "" });
    const worker = await t.run((ctx) => getWorker(ctx, ""));
    assert(worker);
    const state = await t.run((ctx) => getOrCreateWorkerState(ctx, worker));
    expect(worker!.status.kind).toBe("running");
    // ping (gen 1) → stop (bumps to 2, invalidating the canceled runner) →
    // start (bumps to 3).
    expect(state!.generation).toBe(3n);
  });

  test("start is a no-op for an unknown worker", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.start, { name: "ghost" });
    expect(await t.query(api.lib.status, { name: "ghost" })).toBeNull();
  });

  test("a superseded loop generation exits without changing state", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(internal.loop.loop, { name: "", generation: 0n });
    const state = await t.run(async (ctx) => {
      const worker = await getWorker(ctx, "");
      assert(worker);
      return getOrCreateWorkerState(ctx, worker);
    });
    expect(state!.generation).toBe(1n);
  });

  test("ping interrupts a worker sleeping far in the future", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    // Put it to sleep well beyond RUNNING_THRESHOLD_MS (status → idle, runner
    // pending far out).
    await t.run(async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await scheduleWaiting(ctx, w, 10 * RUNNING_THRESHOLD_MS);
    });
    const worker = await t.run((ctx) => getWorker(ctx, ""));
    assert(worker);
    expect(worker.status.kind).toBe("idle");
    const before = await t.run((ctx) => getOrCreateWorkerState(ctx, worker));
    expect(before!.runnerId).toBeDefined();

    await t.mutation(api.lib.ping, {
      name: "",
      workQuery: "",
      workerMutation: "",
    });

    const after = await t.run((ctx) => getOrCreateWorkerState(ctx, worker));
    const workerAfter = await t.run((ctx) => getWorker(ctx, ""));
    expect(workerAfter!.status.kind).toBe("running");
    expect(after!.generation > before!.generation).toBe(true);
    expect(after!.runnerId).not.toBe(before!.runnerId);
  });

  test("ping is a no-op when the loop will run soon", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    // Sleep for less than RUNNING_THRESHOLD_MS — the loop is about to run, so a
    // ping shouldn't disturb it.
    await t.run(async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await scheduleWaiting(ctx, w, RUNNING_THRESHOLD_MS / 2);
    });
    const before = await t.run(async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );

    await t.mutation(api.lib.start, { name: "" });

    const after = await t.run(async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    expect(after!.generation).toBe(before!.generation);
    expect(after!.runnerId).toBe(before!.runnerId);
  });

  test("monitor restarts a dead loop and keeps watching", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    const before = await t.run(async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    await t.run((ctx) => ctx.scheduler.cancel(before!.runnerId!));

    await t.mutation(internal.monitor.monitor, { name: "" });

    const after = await t.run(async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    const worker = await t.run((ctx) => getWorker(ctx, ""));
    assert(worker);
    expect(after!.generation > before!.generation).toBe(true);
    expect(after!.runnerId).not.toBe(before!.runnerId);
    expect(worker!.status.kind).toBe("running");
    expect(after!.monitorId).toBeDefined();
  });

  test("monitor stops itself once the worker is idle", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(api.lib.stop, { name: "" });
    await t.mutation(internal.monitor.monitor, { name: "" });
    const worker = await t.run((ctx) => getWorker(ctx, ""));
    assert(worker);
    expect(worker.status.kind).toBe("stopped");
    const state = await t.run((ctx) => getOrCreateWorkerState(ctx, worker));
    expect(state!.monitorId).toBeUndefined();
  });

  test("independent named workers don't interfere", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs({ name: "a" }));
    await t.mutation(api.lib.ping, pingArgs({ name: "b" }));
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe(
      "running",
    );
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe(
      "running",
    );
    await t.mutation(api.lib.stop, { name: "a" });
    expect((await t.query(api.lib.status, { name: "a" }))?.kind).toBe(
      "stopped",
    );
    expect((await t.query(api.lib.status, { name: "b" }))?.kind).toBe(
      "running",
    );
  });
});
