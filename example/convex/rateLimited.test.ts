import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("rate-limited LLM batches", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("processes every request and fills in responses", async () => {
    const t = initConvexTest();
    for (let i = 0; i < 25; i++) {
      await t.mutation(api.rateLimited.submitRequest, {
        prompt: `prompt ${i}`,
        inputTokens: 100,
      });
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const requests = await t.query(api.rateLimited.listRequests, {});
    expect(requests).toHaveLength(25);
    expect(requests.every((r) => r.state === "finished")).toBe(true);
    expect(requests.every((r) => r.response?.startsWith("Echo:"))).toBe(true);
  });

  test("claims every request once when one transaction's requests span batches", async () => {
    const t = initConvexTest();
    // 11 requests in one transaction — one commit timestamp, split by
    // BATCH_SIZE (5). These are claimed (patched to "started"), not deleted, so
    // the cursor has to resume inside the tie without skipping the rest of it.
    await t.run(async (ctx) => {
      for (let i = 0; i < 11; i++) {
        await ctx.db.insert("llmRequests", {
          prompt: `bulk ${i}`,
          inputTokens: 100,
          state: "pending",
          updatedAt: ctx.db.vars.commitTs,
        });
      }
    });
    // submitRequest is what pings the worker.
    await t.mutation(api.rateLimited.submitRequest, {
      prompt: "last",
      inputTokens: 100,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const requests = await t.query(api.rateLimited.listRequests, {});
    expect(requests).toHaveLength(12);
    expect(requests.every((r) => r.state === "finished")).toBe(true);
    expect(await t.query(api.rateLimited.stats, {})).toEqual({
      pending: 0,
      started: 0,
      finished: 12,
    });
  });

  test("a big batch that exceeds the token budget still completes", async () => {
    const t = initConvexTest();
    // 300k input tokens against a 200k/min budget forces a reservation wait.
    for (let i = 0; i < 30; i++) {
      await t.mutation(api.rateLimited.submitRequest, {
        prompt: `prompt ${i}`,
        inputTokens: 10_000,
      });
    }

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const requests = await t.query(api.rateLimited.listRequests, {});
    expect(requests.every((r) => r.state === "finished")).toBe(true);
  });
});
