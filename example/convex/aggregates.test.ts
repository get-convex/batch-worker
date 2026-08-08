import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api, components } from "./_generated/api";

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

  test("counts a score once even when its batch is re-run over", async () => {
    const t = initConvexTest();
    await t.mutation(api.aggregates.recordScore, { team: "red", points: 5 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Nothing is deleted here, so the folded score is still sitting in the
    // table. Wake the loop again: only the cursor keeps it from being counted
    // a second time.
    await t.mutation(api.aggregates.recordScore, { team: "blue", points: 1 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.aggregates.getTotals, {})).toEqual({
      totals: { red: 5, blue: 1 },
      pending: 0,
    });
    const rows = await t.run((ctx) => ctx.db.query("scoreEvents").collect());
    expect(rows).toHaveLength(2);
  });

  test("counts each score once when a transaction spans a batch boundary", async () => {
    const t = initConvexTest();
    // One transaction, one commit timestamp: 25 scores that BATCH_SIZE (20)
    // splits. Since the cursor is exclusive here, the query has to pull in the
    // rest of that tie — pulling in too few strands scores, too many (i.e.
    // re-reading the rows it already took) folds them twice.
    await t.run(async (ctx) => {
      for (let i = 0; i < 25; i++) {
        await ctx.db.insert("scoreEvents", {
          team: "red",
          points: 1,
          insertedAt: ctx.db.vars.commitTs,
        });
      }
    });
    await t.mutation(api.aggregates.recordScore, { team: "blue", points: 7 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.aggregates.getTotals, {})).toEqual({
      totals: { red: 25, blue: 7 },
      pending: 0,
    });
  });

  test("advances the cursor to the last score it folded", async () => {
    const t = initConvexTest();
    await t.mutation(api.aggregates.recordScore, { team: "red", points: 1 });
    await t.mutation(api.aggregates.recordScore, { team: "red", points: 2 });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const scores = await t.run((ctx) =>
      ctx.db.query("scoreEvents").withIndex("insertedAt").collect(),
    );
    const cursor = await t.run((ctx) =>
      ctx.runQuery(components.batchWorker.lib.getCursor, {
        name: "aggregates",
      }),
    );
    expect(cursor).toBe(scores.at(-1)!.insertedAt);
  });
});
