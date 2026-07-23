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
