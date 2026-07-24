import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("serial aggregate updates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("folds many scores into per-team totals", async () => {
    const t = initConvexTest();
    const expected: Record<string, number> = {};
    const teams = ["red", "blue", "green"];
    for (let i = 1; i <= 50; i++) {
      const team = teams[i % teams.length];
      expected[team] = (expected[team] ?? 0) + i;
      await t.mutation(api.aggregates.recordScore, { team, points: i });
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const totals = await t.query(api.aggregates.getTotals, {});
    expect(totals).toEqual({ totals: expected, pending: 0 });
  });

  test("keeps aggregating after going idle", async () => {
    const t = initConvexTest();
    await t.mutation(api.aggregates.recordScore, { team: "red", points: 3 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.aggregates.getTotals, {})).toEqual({
      totals: { red: 3 },
      pending: 0,
    });

    await t.mutation(api.aggregates.recordScore, { team: "red", points: 4 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.aggregates.getTotals, {})).toEqual({
      totals: { red: 7 },
      pending: 0,
    });
  });
});
