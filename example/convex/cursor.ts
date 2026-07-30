import type { CommitTsPlaceholder } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";

// Resuming a queue scan from a cursor, instead of always reading from the front.
//
// The obvious way to drain a queue is `.take(BATCH_SIZE)` from the start of the
// table and delete the rows you processed. That works, but every delete leaves a
// tombstone in the index until it's vacuumed, and a scan that always starts at
// the front has to walk over them. On a busy queue that turns a fixed-size batch
// into a read that keeps growing.
//
// A `v.commitTs()` field fixes that. The examples here call it `updatedAt`: write
// `ctx.db.vars.commitTs` to it on every insert or patch and it resolves, when
// that mutation commits, to an int64 ordered by *commit* order. Unlike
// `_creationTime` (assigned when the mutation starts, before it knows whether
// it will commit) that makes it safe to remember where a scan stopped — nothing
// can later show up *behind* the cursor. So the worker stores the timestamp it
// got to, and the next scan starts there, past all the tombstones it left.
//
// The examples in this app keep their cursors in one `cursors` table, keyed by
// worker name. Any single-writer spot works — if your worker already updates a
// document each batch (like `totals` in example.ts), a field on that document
// saves a write. Only the worker mutation writes it, so it never conflicts.

/**
 * Rows that a cursor can walk: anything with a `v.commitTs()` `updatedAt`. That
 * field reads back as `bigint | CommitTsPlaceholder` — see `cursorThrough`.
 */
type Updated = { updatedAt: bigint | CommitTsPlaceholder };

function cursorDoc(ctx: QueryCtx, name: string) {
  return ctx.db
    .query("cursors")
    .withIndex("name", (q) => q.eq("name", name))
    .unique();
}

/** Where the next scan for `name` should start (inclusive). */
export async function cursorFor(ctx: QueryCtx, name: string): Promise<bigint> {
  const cursor = await cursorDoc(ctx, name);
  return cursor?.commitTs ?? 0n;
}

/**
 * Record where this batch stopped, so the next one resumes there.
 *
 * The cursor is *inclusive* — scans use `.gte(cursor)`, not `.gt(cursor)`.
 * Everything a single mutation inserts shares one commit timestamp, so a batch
 * can end in the middle of a tie, and `.gt(...)` would skip the rest of that
 * mutation's rows. Re-reading from the tie costs at most one mutation's worth of
 * already-processed rows (tombstones, if the worker deletes them).
 */
export async function advanceCursor(
  ctx: MutationCtx,
  name: string,
  commitTs: bigint,
) {
  const existing = await cursorDoc(ctx, name);
  if (existing) {
    await ctx.db.patch("cursors", existing._id, { commitTs });
  } else {
    await ctx.db.insert("cursors", { name, commitTs });
  }
}

/** Forget where `name` got to, so its next scan starts from the front. */
export async function resetCursor(ctx: MutationCtx, name: string) {
  const existing = await cursorDoc(ctx, name);
  if (existing) {
    await ctx.db.delete("cursors", existing._id);
  }
}

/**
 * How far a batch of rows got: the `updatedAt` of the last row whose timestamp
 * has resolved, or `null` for "don't move the cursor".
 *
 * A row written by the mutation that's reading it back still holds the
 * placeholder — its timestamp isn't assigned until that mutation commits, so
 * there is no number to store yet. Skipping those rows leaves the cursor at the
 * last timestamp we can actually name, which is always *before* the pending
 * writes (they commit later, so they sort after it) — the next scan picks them
 * up. Advancing to a guess would either skip them or walk the cursor backwards.
 *
 * The work query here reads rows committed by *other* mutations, so in practice
 * everything is resolved; the `null` case is what keeps a query that batches its
 * own writes correct. (It's also what `convex-test` hits — it doesn't resolve
 * commit timestamps yet, so the cursor simply never advances there.)
 */
export function cursorThrough(rows: Updated[]): bigint | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const { updatedAt } = rows[i];
    if (typeof updatedAt === "bigint") {
      return updatedAt;
    }
  }
  return null;
}
