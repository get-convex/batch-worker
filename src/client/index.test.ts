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
import {
  batchValidators,
  ping,
  vBatchQueryArgs,
  vBatchResult,
} from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

const schema = defineSchema({
  items: defineTable({ value: v.number() }),
  // For the cursor tests: `marks` is scanned from the cursor and never
  // deleted, so only an advancing cursor keeps the loop from reprocessing.
  marks: defineTable({ seq: v.int64() }).index("seq", ["seq"]),
  // One row per batch, so a test can see how the cursor sliced the marks up.
  batches: defineTable({ seqs: v.array(v.int64()) }),
  // For the custom-cursor test: the cursor here is a string, not a timestamp.
  letters: defineTable({ letter: v.string() }).index("letter", ["letter"]),
  letterBatches: defineTable({ letters: v.array(v.string()) }),
});

const WORKER = "items";
const CURSOR_WORKER = "marks";
const LETTER_WORKER = "letters";

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
    await ping(ctx, components.batchWorker, {
      name: WORKER,
      config: { debounceMs: 0 },
      workQuery: testApi.getBatch,
      workerMutation: testApi.processBatch,
    });
  },
});

export const status = queryGeneric({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.status, { name: WORKER }),
});

export const startWorker = mutationGeneric({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(components.batchWorker.lib.start, { name: WORKER }),
});

export const stopWorker = mutationGeneric({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(components.batchWorker.lib.stop, { name: WORKER }),
});

export const remaining = queryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("items").take(1000)).length,
});

// ── A worker driven purely by its cursor ───────────────────────────────────

const BATCH = 2;

export const getMarks = internalQueryGeneric({
  args: vBatchQueryArgs,
  returns: vBatchResult({ seqs: v.array(v.int64()) }),
  handler: async (ctx, { cursor }) => {
    const marks = await ctx.db
      .query("marks")
      .withIndex("seq", (q) => q.gte("seq", cursor ?? 0n))
      .take(BATCH);
    if (marks.length === 0) {
      return { kind: "idle" as const, cooldownMs: 100, pollIntervalMs: 10 };
    }
    return {
      kind: "work" as const,
      batch: { seqs: marks.map((m) => m.seq as bigint) },
      // Nothing is deleted, so only this advancing cursor ends the drain.
      cursor: (marks.at(-1)!.seq as bigint) + 1n,
    };
  },
});

export const processMarks = internalMutationGeneric({
  args: { seqs: v.array(v.int64()) },
  handler: async (ctx, { seqs }) => {
    await ctx.db.insert("batches", { seqs });
  },
});

// Same query, but the mutation insists the batch only got halfway.
export const processMarksPartially = internalMutationGeneric({
  args: { seqs: v.array(v.int64()) },
  handler: async (ctx, { seqs }) => {
    await ctx.db.insert("batches", { seqs });
    return { cursor: seqs[0]! + 1n };
  },
});

export const enqueueMark = mutationGeneric({
  args: { seq: v.int64(), partial: v.optional(v.boolean()) },
  handler: async (ctx, { seq, partial }) => {
    await ctx.db.insert("marks", { seq });
    await ping(ctx, components.batchWorker, {
      name: CURSOR_WORKER,
      config: { debounceMs: 0 },
      workQuery: testApi.getMarks,
      workerMutation: partial
        ? testApi.processMarksPartially
        : testApi.processMarks,
    });
  },
});

export const markCursor = queryGeneric({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.cursor, { name: CURSOR_WORKER }),
});

export const setMarkCursor = mutationGeneric({
  args: { cursor: v.optional(v.int64()) },
  handler: async (ctx, { cursor }) =>
    ctx.runMutation(components.batchWorker.lib.setCursor, {
      name: CURSOR_WORKER,
      cursor,
    }),
});

export const batches = queryGeneric({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("batches").take(1000)).map((b) => b.seqs),
});

// ── A worker whose cursor isn't a commit timestamp ──────────────────────────

const letterValidators = batchValidators({
  batch: { letters: v.array(v.string()) },
  cursor: v.string(),
});

export const getLetters = internalQueryGeneric({
  args: letterValidators.vQueryArgs,
  returns: letterValidators.vQueryReturns,
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("letters")
      .withIndex("letter", (q) => q.gt("letter", cursor ?? ""))
      .take(BATCH);
    if (rows.length === 0) {
      return { kind: "idle" as const, cooldownMs: 100, pollIntervalMs: 10 };
    }
    return {
      kind: "work" as const,
      batch: { letters: rows.map((r) => r.letter) },
      cursor: rows.at(-1)!.letter,
    };
  },
});

export const processLetters = internalMutationGeneric({
  args: letterValidators.vMutationArgs,
  returns: letterValidators.vMutationReturns,
  handler: async (ctx, { letters }) => {
    await ctx.db.insert("letterBatches", { letters });
    return null;
  },
});

export const enqueueLetter = mutationGeneric({
  args: { letter: v.string() },
  handler: async (ctx, { letter }) => {
    await ctx.db.insert("letters", { letter });
    await ping(ctx, components.batchWorker, {
      name: LETTER_WORKER,
      config: { debounceMs: 0 },
      workQuery: testApi.getLetters,
      workerMutation: testApi.processLetters,
    });
  },
});

export const letterCursor = queryGeneric({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(components.batchWorker.lib.cursor, { name: LETTER_WORKER }),
});

export const letterBatches = queryGeneric({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("letterBatches").take(1000)).map((b) => b.letters),
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
      getMarks: typeof getMarks;
      processMarks: typeof processMarks;
      processMarksPartially: typeof processMarksPartially;
      enqueueMark: typeof enqueueMark;
      markCursor: typeof markCursor;
      setMarkCursor: typeof setMarkCursor;
      batches: typeof batches;
      getLetters: typeof getLetters;
      processLetters: typeof processLetters;
      enqueueLetter: typeof enqueueLetter;
      letterCursor: typeof letterCursor;
      letterBatches: typeof letterBatches;
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

describe("Cursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("round-trips from the query back into the next call's args", async () => {
    const t = initConvexTest(schema);
    for (const seq of [0n, 1n, 2n, 3n]) {
      await t.mutation(testApi.enqueueMark, { seq });
    }
    // Nothing deletes the marks, so draining at all means the cursor came back
    // as `args.cursor` — otherwise the query keeps handing out the same batch.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(testApi.batches, {})).toEqual([
      [0n, 1n],
      [2n, 3n],
    ]);
    expect(await t.query(testApi.markCursor, {})).toBe(4n);
  });

  test("a cursor from the mutation overrides the query's", async () => {
    const t = initConvexTest(schema);
    for (const seq of [0n, 1n]) {
      await t.mutation(testApi.enqueueMark, { seq, partial: true });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The query proposed 2n each time; the mutation only claimed the first
    // mark of each batch, so the loop re-reads from there and inches forward.
    expect(await t.query(testApi.batches, {})).toEqual([[0n, 1n], [1n]]);
    expect(await t.query(testApi.markCursor, {})).toBe(2n);
  });

  test("setCursor overwrites it, and clears it when omitted", async () => {
    const t = initConvexTest(schema);
    await t.mutation(testApi.enqueueMark, { seq: 0n });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(testApi.markCursor, {})).toBe(1n);

    await t.mutation(testApi.setMarkCursor, { cursor: 99n });
    expect(await t.query(testApi.markCursor, {})).toBe(99n);

    await t.mutation(testApi.setMarkCursor, {});
    expect(await t.query(testApi.markCursor, {})).toBe(null);
  });

  test("can be a type other than a commit timestamp", async () => {
    const t = initConvexTest(schema);
    for (const letter of ["a", "b", "c"]) {
      await t.mutation(testApi.enqueueLetter, { letter });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(testApi.letterBatches, {})).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(await t.query(testApi.letterCursor, {})).toBe("c");
  });
});
