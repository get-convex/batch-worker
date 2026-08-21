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
import type { MutationCtx } from "./functions.js";
import {
  continueRunning,
  ensureMonitored,
  getWorker,
  getOrCreateWorkerState,
  scheduleWaiting,
  start,
} from "./kick.js";
import { createMockLogger, type Logger } from "./logging.js";
import { RUNNING_THRESHOLD_MS } from "./shared.js";

// Component helpers expect `ctx.log` (injected by the function builders in
// `functions.ts`); convex-test's raw ctx has none, so add one here. Defaults to
// a silent mock logger; pass one in to assert logging side-effects.
const run = <T>(
  t: {
    run: <O>(fn: (ctx: Omit<MutationCtx, "log">) => Promise<O>) => Promise<O>;
  },
  fn: (ctx: MutationCtx) => Promise<T>,
  log: Logger = createMockLogger(),
): Promise<T> => t.run((ctx) => fn(Object.assign(ctx, { log })));

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
    await run(t, async (ctx) => {
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
    await run(t, async (ctx) => {
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
    const before = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    await t.mutation(api.lib.ping, pingArgs());
    const after = await run(t, async (ctx) =>
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
    await run(t, async (ctx) => {
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
    const worker = await run(t, (ctx) => getWorker(ctx, ""));
    assert(worker);
    const state = await run(t, (ctx) => getOrCreateWorkerState(ctx, worker));
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

  test("logging is captured as a side-effect", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs()); // worker is now running
    const log = createMockLogger();
    // start on an already-running worker is a no-op that logs at debug.
    await run(t, (ctx) => start(ctx, ""), log);
    expect(
      log.logs.some(
        (l) => l.level === "debug" && String(l.args[0]).includes("[start]"),
      ),
    ).toBe(true);
  });

  test("a superseded loop generation exits without changing state", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await t.mutation(internal.loop.loop, { name: "", generation: 0n });
    const state = await run(t, async (ctx) => {
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
    await run(t, async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await scheduleWaiting(ctx, w, 10 * RUNNING_THRESHOLD_MS);
    });
    const worker = await run(t, (ctx) => getWorker(ctx, ""));
    assert(worker);
    expect(worker.status.kind).toBe("idle");
    const before = await run(t, (ctx) => getOrCreateWorkerState(ctx, worker));
    expect(before!.runnerId).toBeDefined();

    await t.mutation(api.lib.ping, {
      name: "",
      workQuery: "",
      workerMutation: "",
    });

    const after = await run(t, (ctx) => getOrCreateWorkerState(ctx, worker));
    const workerAfter = await run(t, (ctx) => getWorker(ctx, ""));
    expect(workerAfter!.status.kind).toBe("running");
    expect(after!.generation > before!.generation).toBe(true);
    expect(after!.runnerId).not.toBe(before!.runnerId);
  });

  test("waking from a wait refreshes the cooldown window", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await run(t, async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await scheduleWaiting(ctx, w, 60_000);
    });
    vi.advanceTimersByTime(10_000);

    await t.mutation(api.lib.ping, pingArgs());

    // The woken run gets a full cooldown window, so a pool with no runnable
    // work (e.g. saturated) can't bounce straight back to idle on every ping.
    const state = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    expect(state!.lastWorkTs).toBe(Date.now());
  });

  test("continueRunning from idle refreshes the cooldown window", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    await run(t, async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await scheduleWaiting(ctx, w, 60_000);
    });
    vi.advanceTimersByTime(60_000);

    await run(t, async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await continueRunning(ctx, w, 0);
    });

    const worker = await run(t, (ctx) => getWorker(ctx, ""));
    expect(worker!.status.kind).toBe("running");
    const state = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, worker!),
    );
    expect(state!.lastWorkTs).toBe(Date.now());
  });

  test("ping is a no-op when the loop will run soon", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    // Sleep for less than RUNNING_THRESHOLD_MS — the loop is about to run, so a
    // ping shouldn't disturb it.
    await run(t, async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await scheduleWaiting(ctx, w, RUNNING_THRESHOLD_MS / 2);
    });
    const before = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );

    await t.mutation(api.lib.start, { name: "" });

    const after = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    expect(after!.generation).toBe(before!.generation);
    expect(after!.runnerId).toBe(before!.runnerId);
  });

  test("ping keeps a loop scheduled within the debounce window but marks it running", async () => {
    const t = convexTest(schema, modules);
    const config = { debounceMs: 20 * RUNNING_THRESHOLD_MS };
    await t.mutation(api.lib.ping, pingArgs({ config }));
    // Sleep beyond RUNNING_THRESHOLD_MS but sooner than a debounced reschedule
    // would run — canceling it would only delay the work.
    await run(t, async (ctx) => {
      const w = await getWorker(ctx, "");
      assert(w);
      await scheduleWaiting(ctx, w, 10 * RUNNING_THRESHOLD_MS);
    });
    const before = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );

    await t.mutation(api.lib.ping, pingArgs({ config }));

    const after = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    expect(after!.generation).toBe(before!.generation);
    expect(after!.runnerId).toBe(before!.runnerId);
    const worker = await run(t, (ctx) => getWorker(ctx, ""));
    expect(worker!.status.kind).toBe("running");

    // Later pings now no-op on the status check alone.
    await t.mutation(api.lib.ping, pingArgs({ config }));
    const stateAfter = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    expect(stateAfter!.runnerId).toBe(before!.runnerId);
  });

  test("monitor restarts a dead loop and keeps watching", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    const before = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    await run(t, (ctx) => ctx.scheduler.cancel(before!.runnerId!));

    await t.mutation(internal.monitor.monitor, { name: "" });

    const after = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    const worker = await run(t, (ctx) => getWorker(ctx, ""));
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
    const worker = await run(t, (ctx) => getWorker(ctx, ""));
    assert(worker);
    expect(worker.status.kind).toBe("stopped");
    const state = await run(t, (ctx) => getOrCreateWorkerState(ctx, worker));
    expect(state!.monitorId).toBeUndefined();
  });

  // A loop run the scheduler keeps retrying after system failures stays
  // "pending" at its original scheduledTime. The tests below simulate that
  // wedged state by moving the clock past the runner without executing it.
  describe("runner stuck pending in the past", () => {
    test("monitor recovers it instead of re-arming behind it", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(api.lib.ping, pingArgs());
      const before = await run(t, async (ctx) =>
        getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
      );
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);

      await t.mutation(internal.monitor.monitor, { name: "" });

      const after = await run(t, async (ctx) =>
        getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
      );
      expect(after!.generation > before!.generation).toBe(true);
      expect(after!.runnerId).not.toBe(before!.runnerId);
      // The stuck runner must be canceled, which is what stops the scheduler
      // from retrying it.
      const old = await run(t, (ctx) =>
        ctx.db.system.get("_scheduled_functions", before!.runnerId!),
      );
      expect(old?.state.kind).toBe("canceled");
      // And the monitor must be re-armed in the future; scheduled in the past
      // it would fire again immediately, forever.
      expect(after!.monitorRunAtMs).toBeGreaterThan(Date.now());
    });

    test("ensureMonitored never schedules the monitor in the past", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(api.lib.ping, pingArgs());
      const staleLoopRunAt = Date.now();
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      await run(t, async (ctx) => {
        const worker = await getWorker(ctx, "");
        assert(worker);
        await ensureMonitored(ctx, worker, staleLoopRunAt);
      });
      const state = await run(t, async (ctx) =>
        getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
      );
      expect(state!.monitorRunAtMs).toBeGreaterThan(Date.now());
    });

    test("monitor recovers it while the worker is waiting", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(api.lib.ping, pingArgs());
      // Waiting state: runner pending 5s out, status idle. The monitor is the
      // only recovery path here since pings no-op on an imminent runner.
      await run(t, async (ctx) => {
        const w = await getWorker(ctx, "");
        assert(w);
        await scheduleWaiting(ctx, w, 5000);
      });
      const before = await run(t, async (ctx) =>
        getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
      );
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);

      await t.mutation(internal.monitor.monitor, { name: "" });

      const after = await run(t, async (ctx) =>
        getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
      );
      const worker = await run(t, (ctx) => getWorker(ctx, ""));
      expect(worker!.status.kind).toBe("running");
      expect(after!.generation > before!.generation).toBe(true);
      expect(after!.runnerId).not.toBe(before!.runnerId);
      const old = await run(t, (ctx) =>
        ctx.db.system.get("_scheduled_functions", before!.runnerId!),
      );
      expect(old?.state.kind).toBe("canceled");
    });

    test("monitor leaves an on-time pending runner alone", async () => {
      const t = convexTest(schema, modules);
      await t.mutation(api.lib.ping, pingArgs());
      const before = await run(t, async (ctx) =>
        getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
      );

      await t.mutation(internal.monitor.monitor, { name: "" });

      const after = await run(t, async (ctx) =>
        getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
      );
      expect(after!.generation).toBe(before!.generation);
      expect(after!.runnerId).toBe(before!.runnerId);
    });
  });

  test("kick recovers a worker whose scheduled functions were canceled", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(api.lib.ping, pingArgs());
    const before = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    // Cancel both out from under the worker, as the dashboard's cancel-all
    // does. Status stays "running", so pings no-op and the monitor that would
    // recover the loop no longer exists.
    await run(t, async (ctx) => {
      await ctx.scheduler.cancel(before!.runnerId!);
      await ctx.scheduler.cancel(before!.monitorId!);
    });
    await t.mutation(api.lib.ping, pingArgs());
    const wedged = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    expect(wedged!.runnerId).toBe(before!.runnerId);

    await t.mutation(api.lib.kick, { name: "" });

    const after = await run(t, async (ctx) =>
      getOrCreateWorkerState(ctx, (await getWorker(ctx, ""))!),
    );
    const worker = await run(t, (ctx) => getWorker(ctx, ""));
    expect(worker!.status.kind).toBe("running");
    expect(after!.generation > before!.generation).toBe(true);
    expect(after!.runnerId).not.toBe(before!.runnerId);
    expect(after!.monitorId).not.toBe(before!.monitorId);
    expect(after!.monitorRunAtMs).toBeGreaterThan(Date.now());
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
