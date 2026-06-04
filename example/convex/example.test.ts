import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("example worker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("processes a single event", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.addEvent, { value: 5 });

    // Run the debounced loop (and everything it schedules) to completion.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const totals = await t.query(api.example.getTotals, {});
    expect(totals).toEqual({ total: 5, count: 1 });
  });

  test("batches many events across iterations", async () => {
    const t = initConvexTest();
    // 25 events => 3 batches of 10/10/5.
    let expected = 0;
    for (let i = 1; i <= 25; i++) {
      expected += i;
      await t.mutation(api.example.addEvent, { value: i });
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const totals = await t.query(api.example.getTotals, {});
    expect(totals).toEqual({ total: expected, count: 25 });
  });

  test("worker goes idle after draining the queue", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.addEvent, { value: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = await t.query(api.example.workerStatus, {});
    expect(status?.kind).toBe("idle");

    const totals = await t.query(api.example.getTotals, {});
    expect(totals.count).toBe(1);
  });

  test("re-runs when work is added after going idle", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.addEvent, { value: 10 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(api.example.getTotals, {})).total).toBe(10);

    // Now idle; add more and confirm it kicks again.
    await t.mutation(api.example.addEvent, { value: 7 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.example.getTotals, {})).toEqual({
      total: 17,
      count: 2,
    });
  });
});
