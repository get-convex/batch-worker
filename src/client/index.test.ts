/// <reference types="vite/client" />

import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  anyApi,
  type ApiFromModules,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { BatchWorker, vBatchQueryArgs, vBatchResult } from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

const schema = defineSchema({
  items: defineTable({ value: v.number() }),
});

const worker = new BatchWorker(components.batchWorker, {
  config: { debounceMs: 0 },
});

export const getBatch = internalQueryGeneric({
  args: vBatchQueryArgs,
  returns: vBatchResult(v.object({ ids: v.array(v.id("items")) })),
  handler: async (ctx) => {
    const items = await ctx.db.query("items").take(5);
    if (items.length === 0) {
      // Cool down quickly so the test's scheduled-function drain terminates.
      return { kind: "idle" as const, cooldownMs: 100, pollIntervalMs: 10 };
    }
    return {
      kind: "work" as const,
      batch: { ids: items.map((i) => i._id) },
    };
  },
});

export const processBatch = internalMutationGeneric({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      await ctx.db.delete("items", id);
    }
  },
});

export const enqueue = mutationGeneric({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("items", { value });
    await worker.ping(ctx, {
      workQuery: testApi.getBatch,
      workerMutation: testApi.processBatch,
    });
  },
});

export const status = queryGeneric({
  args: {},
  handler: async (ctx) => worker.status(ctx),
});

export const startWorker = mutationGeneric({
  args: {},
  handler: async (ctx) => worker.start(ctx),
});

export const stopWorker = mutationGeneric({
  args: {},
  handler: async (ctx) => worker.stop(ctx),
});

export const remaining = queryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("items").take(1000)).length,
});

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      getBatch: typeof getBatch;
      processBatch: typeof processBatch;
      enqueue: typeof enqueue;
      status: typeof status;
      startWorker: typeof startWorker;
      stopWorker: typeof stopWorker;
      remaining: typeof remaining;
    };
  }>
)["index.test"];

describe("Worker client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("ping drives the loop and processes work", async () => {
    const t = initConvexTest(schema);
    await t.mutation(testApi.enqueue, { value: 1 });
    await t.mutation(testApi.enqueue, { value: 2 });

    expect((await t.query(testApi.status, {}))?.kind).toBe("running");

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(testApi.remaining, {})).toBe(0);
    expect((await t.query(testApi.status, {}))?.kind).toBe("idle");
  });

  test("stop halts the worker; start resumes it", async () => {
    const t = initConvexTest(schema);
    await t.mutation(testApi.enqueue, { value: 1 });
    await t.mutation(testApi.stopWorker, {});
    expect((await t.query(testApi.status, {}))?.kind).toBe("stopped");

    await t.mutation(testApi.startWorker, {});
    expect((await t.query(testApi.status, {}))?.kind).toBe("running");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(testApi.remaining, {})).toBe(0);
  });
});
