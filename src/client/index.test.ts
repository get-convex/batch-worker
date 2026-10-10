/// <reference types="vite/client" />

import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defineSchema, defineTable } from "convex/server";
import { defineTestApp } from "convex-test";
import componentTest from "../test.js";
import {
  defineBatchWorkerValidators,
  ping,
  vBatchQueryArgs,
  vBatchResult,
} from "./index.js";

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

const app = defineTestApp({
  schema,
  components: {
    batchWorker: componentTest,
  },
});

const WORKER = "items";
const CURSOR_WORKER = "marks";
const LETTER_WORKER = "letters";

const getBatch = app.internalQuery({
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

const processBatch = app.internalMutation({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) {
      await ctx.db.delete("items", id);
    }
  },
});

const enqueue = app.mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }): Promise<void> => {
    await ctx.db.insert("items", { value });
    await ping(ctx, app.components.batchWorker, {
      name: WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getBatch,
      workerMutation: internal.worker.processBatch,
    });
  },
});

const status = app.query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(app.components.batchWorker.lib.status, { name: WORKER }),
});

const startWorker = app.mutation({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(app.components.batchWorker.lib.start, { name: WORKER }),
});

const stopWorker = app.mutation({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(app.components.batchWorker.lib.stop, { name: WORKER }),
});

const remaining = app.query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("items").take(1000)).length,
});

// ── A worker driven purely by its cursor ───────────────────────────────────

const BATCH = 2;

const getMarks = app.internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult({ seqs: v.array(v.int64()) }),
  handler: async (ctx, { cursor }) => {
    const marks = await ctx.db
      .query("marks")
      .withIndex("seq", (q) =>
        q.gte("seq", (cursor as bigint | undefined) ?? 0n),
      )
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

const processMarks = app.internalMutation({
  args: { seqs: v.array(v.int64()) },
  handler: async (ctx, { seqs }) => {
    await ctx.db.insert("batches", { seqs });
  },
});

// Same query, but the mutation insists the batch only got halfway.
const processMarksPartially = app.internalMutation({
  args: { seqs: v.array(v.int64()) },
  handler: async (ctx, { seqs }) => {
    await ctx.db.insert("batches", { seqs });
    return { cursor: seqs[0]! + 1n };
  },
});

const enqueueMark = app.mutation({
  args: { seq: v.int64(), partial: v.optional(v.boolean()) },
  handler: async (ctx, { seq, partial }): Promise<void> => {
    await ctx.db.insert("marks", { seq });
    await ping(ctx, app.components.batchWorker, {
      name: CURSOR_WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getMarks,
      workerMutation: partial
        ? internal.worker.processMarksPartially
        : internal.worker.processMarks,
    });
  },
});

const markCursor = app.query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(app.components.batchWorker.lib.getCursor, {
      name: CURSOR_WORKER,
    }),
});

const setMarkCursor = app.mutation({
  args: { cursor: v.optional(v.int64()) },
  handler: async (ctx, { cursor }) =>
    ctx.runMutation(app.components.batchWorker.lib.setCursor, {
      name: CURSOR_WORKER,
      cursor,
    }),
});

const batches = app.query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("batches").take(1000)).map((b) => b.seqs),
});

// Seeding a cursor before the worker gets to process anything: `ping` creates
// the worker, `stop` in the same mutation keeps its loop from running.
const seedMarks = app.mutation({
  args: { seqs: v.array(v.int64()), cursor: v.int64() },
  handler: async (ctx, { seqs, cursor }): Promise<void> => {
    for (const seq of seqs) {
      await ctx.db.insert("marks", { seq });
    }
    await ping(ctx, app.components.batchWorker, {
      name: CURSOR_WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getMarks,
      workerMutation: internal.worker.processMarks,
    });
    await ctx.runMutation(app.components.batchWorker.lib.stop, {
      name: CURSOR_WORKER,
    });
    await ctx.runMutation(app.components.batchWorker.lib.setCursor, {
      name: CURSOR_WORKER,
      cursor,
    });
  },
});

const startMarks = app.mutation({
  args: {},
  handler: async (ctx) =>
    ctx.runMutation(app.components.batchWorker.lib.start, {
      name: CURSOR_WORKER,
    }),
});

// ── A worker whose cursor isn't a commit timestamp ──────────────────────────

const letterValidators = defineBatchWorkerValidators({
  batch: { letters: v.array(v.string()) },
  cursor: v.string(),
});

const getLetters = app.internalQuery({
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

const processLetters = app.internalMutation({
  args: letterValidators.vMutationArgs,
  returns: letterValidators.vMutationReturns,
  handler: async (ctx, { letters }) => {
    await ctx.db.insert("letterBatches", { letters });
    return null;
  },
});

const enqueueLetter = app.mutation({
  args: { letter: v.string() },
  handler: async (ctx, { letter }): Promise<void> => {
    await ctx.db.insert("letters", { letter });
    await ping(ctx, app.components.batchWorker, {
      name: LETTER_WORKER,
      config: { debounceMs: 0 },
      workQuery: internal.worker.getLetters,
      workerMutation: internal.worker.processLetters,
    });
  },
});

const letterCursor = app.query({
  args: {},
  handler: async (ctx) =>
    ctx.runQuery(app.components.batchWorker.lib.getCursor, {
      name: LETTER_WORKER,
    }),
});

const letterBatches = app.query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("letterBatches").take(1000)).map((b) => b.letters),
});

const { api, internal, createTest } = app.defineModules({
  worker: {
    getBatch,
    processBatch,
    enqueue,
    status,
    startWorker,
    stopWorker,
    remaining,
    getMarks,
    processMarks,
    processMarksPartially,
    enqueueMark,
    markCursor,
    setMarkCursor,
    batches,
    seedMarks,
    startMarks,
    getLetters,
    processLetters,
    enqueueLetter,
    letterCursor,
    letterBatches,
  },
});

describe("Worker client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("ping drives the loop and processes work", async () => {
    const t = createTest();
    await t.mutation(api.worker.enqueue, { value: 1 });
    await t.mutation(api.worker.enqueue, { value: 2 });

    expect((await t.query(api.worker.status, {}))?.kind).toBe("running");

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.worker.remaining, {})).toBe(0);
    expect((await t.query(api.worker.status, {}))?.kind).toBe("idle");
  });

  test("stop halts the worker; start resumes it", async () => {
    const t = createTest();
    await t.mutation(api.worker.enqueue, { value: 1 });
    await t.mutation(api.worker.stopWorker, {});
    expect((await t.query(api.worker.status, {}))?.kind).toBe("stopped");

    await t.mutation(api.worker.startWorker, {});
    expect((await t.query(api.worker.status, {}))?.kind).toBe("running");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.worker.remaining, {})).toBe(0);
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
    const t = createTest();
    for (const seq of [0n, 1n, 2n, 3n]) {
      await t.mutation(api.worker.enqueueMark, { seq });
    }
    // Nothing deletes the marks, so the query only stops handing out the same
    // batch once the cursor comes back to it as `args.cursor`.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.worker.batches, {})).toEqual([
      [0n, 1n],
      [2n, 3n],
    ]);
    expect(await t.query(api.worker.markCursor, {})).toBe(4n);
  });

  test("a cursor from the mutation overrides the query's", async () => {
    const t = createTest();
    for (const seq of [0n, 1n]) {
      await t.mutation(api.worker.enqueueMark, { seq, partial: true });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The query proposed 2n each time; the mutation only claimed the first
    // mark of each batch, so the loop re-reads from there and inches forward.
    expect(await t.query(api.worker.batches, {})).toEqual([[0n, 1n], [1n]]);
    expect(await t.query(api.worker.markCursor, {})).toBe(2n);
  });

  test("setCursor overwrites it, and clears it when omitted", async () => {
    const t = createTest();
    await t.mutation(api.worker.enqueueMark, { seq: 0n });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.worker.markCursor, {})).toBe(1n);

    await t.mutation(api.worker.setMarkCursor, { cursor: 99n });
    expect(await t.query(api.worker.markCursor, {})).toBe(99n);

    await t.mutation(api.worker.setMarkCursor, {});
    expect(await t.query(api.worker.markCursor, {})).toBe(null);
  });

  test("can be seeded before the worker processes anything", async () => {
    const t = createTest();
    await t.mutation(api.worker.seedMarks, {
      seqs: [0n, 1n, 2n, 3n],
      cursor: 2n,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.worker.batches, {})).toEqual([]);

    // A ping doesn't resume a stopped worker, so the cursor stays seeded.
    await t.mutation(api.worker.enqueueMark, { seq: 4n });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.worker.batches, {})).toEqual([]);

    // `start` is what resumes it, and the scan begins at the seeded cursor.
    await t.mutation(api.worker.startMarks, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.worker.batches, {})).toEqual([[2n, 3n], [4n]]);
  });

  test("can be a type other than a commit timestamp", async () => {
    const t = createTest();
    for (const letter of ["a", "b", "c"]) {
      await t.mutation(api.worker.enqueueLetter, { letter });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.worker.letterBatches, {})).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    expect(await t.query(api.worker.letterCursor, {})).toBe("c");
  });
});
