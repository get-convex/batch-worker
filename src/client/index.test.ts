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
import { Worker } from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

const schema = defineSchema({
  items: defineTable({ value: v.number() }),
});

const worker = new Worker(components.worker, {
  config: { debounceMs: 0, pollIntervalMs: 10, cooldownMs: 100 },
});

export const getBatch = internalQueryGeneric({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("items").take(5);
    if (items.length === 0) return null;
    return {
      ids: items.map((i: { _id: string }) => i._id),
      values: items.map((i: { value: number }) => i.value),
    };
  },
});

export const processBatch = internalMutationGeneric({
  args: { ids: v.array(v.id("items")), values: v.array(v.number()) },
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
    await worker.ensureRunning(ctx, {
      workQuery: testApi.getBatch,
      workerMutation: testApi.processBatch,
      queryArgs: {},
    });
  },
});

export const status = queryGeneric({
  args: {},
  handler: async (ctx) => worker.status(ctx),
});

export const stop = mutationGeneric({
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
      stop: typeof stop;
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

  test("ensureRunning drives the loop and processes work", async () => {
    const t = initConvexTest(schema);
    await t.mutation(testApi.enqueue, { value: 1 });
    await t.mutation(testApi.enqueue, { value: 2 });

    // Worker should be active right after enqueue.
    expect((await t.query(testApi.status, {}))?.kind).toBe("active");

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(testApi.remaining, {})).toBe(0);
    expect((await t.query(testApi.status, {}))?.kind).toBe("idle");
  });

  test("stop halts the worker", async () => {
    const t = initConvexTest(schema);
    await t.mutation(testApi.enqueue, { value: 1 });
    await t.mutation(testApi.stop, {});
    expect((await t.query(testApi.status, {}))?.kind).toBe("idle");
  });
});
