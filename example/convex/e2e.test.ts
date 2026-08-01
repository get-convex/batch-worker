import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("e2e harness worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("drains a burst inserted by a single transaction", async () => {
    const t = initConvexTest();
    // `enqueue` inserts all 60 in one transaction, so they share one commit
    // timestamp and BATCH_SIZE (25) splits it twice over.
    await t.mutation(api.e2e.enqueue, { count: 60 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.e2e.pending, {})).toBe(0);
    const samples = await t.query(api.e2e.samples, {});
    expect(samples.map((s) => s.batchSize)).toEqual([25, 25, 10]);
  });

  test("reset clears the cursor, and the worker picks up from scratch", async () => {
    const t = initConvexTest();
    await t.mutation(api.e2e.enqueue, { count: 5 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.mutation(api.e2e.reset, {});
    const cursor = await t.run((ctx) =>
      ctx.db
        .query("cursors")
        .withIndex("name", (q) => q.eq("name", "e2e"))
        .unique(),
    );
    expect(cursor).toBeNull();
    expect(await t.query(api.e2e.samples, {})).toEqual([]);

    await t.mutation(api.e2e.enqueue, { count: 3 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.e2e.pending, {})).toBe(0);
    expect(await t.query(api.e2e.samples, {})).toHaveLength(1);
  });
});
