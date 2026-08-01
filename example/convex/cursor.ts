import type { MutationCtx, QueryCtx } from "./_generated/server.js";

// Resuming a queue scan from a cursor, instead of always reading from the front.
//
// The obvious way to drain a queue is `.take(BATCH_SIZE)` from the start of the
// table and delete the rows you processed. That works, but every delete leaves a
// tombstone in the index until it's vacuumed (a few minutes later), and a scan
// that always starts at the front has to walk over them. On a busy queue that
// turns a fixed-size batch into a read that keeps growing.
//
// A `v.commitTs()` field fixes that. The examples here call it `insertedAt` or
// `updatedAt`. Write `ctx.db.vars.commitTs` to it on every insert or patch and
// it resolves, when that mutation commits, to an int64 ordered by commit order.
// It is safe to use as a cursor because nothing can be inserted in the past.
// By comparison, `_creationTime` does not work because it's assigned based on
// when the mutation starts, so it may be committed in the past after reading
// a more recent event.
// The worker stores the timestamp it got to, and the next scan starts there,
// skipping all the tombstones from previous deletes.
//
// The examples in this app keep their cursors in one `cursors` table, keyed by
// worker name. Any single-writer spot works — if your worker already updates a
// document each batch (like `totals` in example.ts), a field on that document
// saves a write. Only the worker mutation should write it, to avoid write conflicts.
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
