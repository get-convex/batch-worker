# Batch Worker

[![npm version](https://badge.fury.io/js/@convex-dev%2Fbatch-worker.svg)](https://badge.fury.io/js/@convex-dev/batch-worker)

<!-- START: Include on https://convex.dev/components -->

Run a single background "main loop" over work you insert into your own table —
with scheduling, debouncing, and recovery built in.

You bring two functions:

- A **work query** that returns the next batch of work, or explicitly go idle.
- A **worker mutation** that processes that batch.

Call `ping(...)` once to create the worker. The component takes care of the rest,
built on Convex's **retry-on-change**: when the queue drains the loop *suspends*
instead of polling, and re-runs reactively the moment new work is inserted.

- Runs exactly one loop at a time per named Worker.
- Supports debouncing bursts so they batch together.
- Uses snapshot reads while draining so concurrent inserts don't cause OCC
  retries, and confirms with a real read before suspending so nothing is lost.
- **Suspends when the queue drains** (holding a subscription to your work
  query), and **wakes reactively** when you insert new work — no polling, no
  cooldown. An optional `timeoutMs` bounds the wait.
- Survives backend restarts (suspended loops are durable) and **retries instead
  of dying** if your work query or worker mutation throws, logging the failure
  so you can alert on it.

This is the pattern behind components like
[Workpool](https://github.com/get-convex/workpool) — extracted so you can build
your own "process a queue" components on top of it.

Found a bug? Feature request?
[File it here](https://github.com/get-convex/batch-worker/issues).

## Installation

Create a `convex.config.ts` file in your app's `convex/` folder and install the
component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";

const app = defineApp();
app.use(batchWorker, { env: { LOG_LEVEL: "REPORT" } });

export default app;
```

## Usage

Insert work into your own table, then call `ping`. Provide a query (typed with
`vBatchQueryArgs` / `vBatchResult`) that returns the next batch or `idle`, and a
mutation that processes it. The query's `batch` shape must match the mutation's
args.

```ts
import { v } from "convex/values";
import { ping, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";

const BATCH_SIZE = 10;

// Insert work, then make sure the loop exists. `ping` is only needed to create
// (or `start`) the worker — once it's running, inserting work wakes the
// suspended loop reactively, so pinging on every insert is optional (and a
// cheap no-op while it runs).
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("events", { value });
    await ping(ctx, components.batchWorker, {
      name: "events", // distinct names give you independent queues
      workQuery: internal.example.getBatch,
      workerMutation: internal.example.processBatch,
    });
  },
});

// Return the next batch of work, or `idle` when there's nothing to do.
export const getBatch = internalQuery({
  args: vBatchQueryArgs, // { name } — lets one query serve multiple queues
  returns: vBatchResult(v.object({ ids: v.array(v.id("events")) })),
  handler: async (ctx) => {
    const events = await ctx.db.query("events").take(BATCH_SIZE);
    if (events.length === 0) {
      return { kind: "idle" as const };
      // Or, if you know when the next item is due:
      // return { kind: "idle" as const, timeoutMs: 30_000 };
    }
    return { kind: "work" as const, batch: { ids: events.map((e) => e._id) } };
  },
});

// Process one batch. The worker owns cleanup — delete what you process!
export const processBatch = internalMutation({
  args: { ids: v.array(v.id("events")) },
  handler: async (ctx, { ids }) => {
    // ... do the work (sum, call an API, schedule downstream jobs, etc.) ...
    for (const id of ids) {
      await ctx.db.delete("events", id);
    }
    // Returning nothing re-runs immediately to drain the rest.
  },
});
```

The component **does not clean up your work for you** — your worker mutation is
responsible for deleting (or marking complete / advancing past) the rows it
processed, otherwise the next query will return them again.

### Steering the loop dynamically

Your worker mutation may return `{ debounceMs }` to throttle the
loop:

```ts
return {
  // Don't run again — and ignore pings — for at least this long (debounce).
  debounceMs: 30_000,
};
```

Similarly, when there's no work your query returns `{ kind: "idle" }` and the
loop suspends until new work is inserted. Add a `timeoutMs` to also wake after a
fixed time even if no new work arrives (e.g. when you know the next item is due):

```ts
return {
  kind: "idle",
  // Wake and re-run the query by this long from now at the latest, even with no
  // new work. Inserting work wakes it sooner. Measured from this query response,
  // so re-run it each query if you want it to track a fixed deadline. Omit to
  // suspend until new work arrives.
  timeoutMs: 60_000,
};
```

### Multiple queues

Give each queue a distinct `name`. The name is passed to your query as
`args.name`, so one query/mutation pair can serve many queues:

```ts
await ping(ctx, components.batchWorker, {
  name: "emails",
  workQuery: internal.email.getBatch,
  workerMutation: internal.email.send,
});
```

### Configuration

Pass `config` to `ping` (it's stored on the worker and refreshed when it
changes):

```ts
await ping(ctx, components.batchWorker, {
  name: "events",
  workQuery: internal.example.getBatch,
  workerMutation: internal.example.processBatch,
  config: {
    debounceMs: 100, // wait before the first batch so a burst accumulates
    // If your work query or worker mutation throws, the loop suspends and
    // retries after this long instead of dying. Default 1 minute.
    retryBackoffMs: 15_000,
  },
});
```

Log level is set via the component's `LOG_LEVEL` env var (see Installation).

### Stopping & resuming

`stop` halts processing entirely: the loop stops and `ping` is ignored, so no
new work is picked up. `start` resumes it (reusing the last `ping`ed
query/mutation). Call them on the component:

```ts
await ctx.runMutation(components.batchWorker.lib.stop, { name: "events" });
// ...later, when you want it processing again:
await ctx.runMutation(components.batchWorker.lib.start, { name: "events" });
```

`status` reports the run state, including whether the worker is `stopped`.

### `ping` vs `start`

- **`ping`** creates the worker on first call. It's a no-op afterward — while the
  loop is running (or suspended) new work wakes it reactively, and while
  `stopped` it's ignored.
- **`start`** resumes a `stopped` worker, and only `start` will — `ping` won't.

See the full working example in [example.ts](./example/convex/example.ts).

<!-- END: Include on https://convex.dev/components -->

## Development

Run the example app with a file watcher that rebuilds the component:

```sh
npm i
npm run dev
```

Run `npm run dev:frontend` to interact with it through a Vite app.

### How it works

A single `workers` table holds one row per named worker (handles, config, and
run-status: `running` / `stopped`). The `loop` is a scheduled, top-level
mutation that runs one iteration and then decides how to continue:

- **Work available** — it runs the worker mutation and reschedules itself to
  drain the rest (a committed `scheduler.runAfter`). The scan uses a _snapshot_
  read so concurrent inserts don't OCC-conflict while draining.
- **Queue empty** — it re-reads the work query with a real dependency (catching
  a racing insert and subscribing to the query's read set) and then **suspends**
  via Convex's retry-on-change (`requestRetry`). Inserting new work invalidates
  that read set and re-runs the loop reactively; an optional `timeoutMs` bounds
  the wait. Suspended loops are durable across backend restarts.
- **Failure** — if the work query or worker mutation throws, the loop suspends
  and retries after `retryBackoffMs` instead of dying.

At most one continuation exists per worker at any time — a scheduled run on the
work path, or a single suspended run on the idle path — so there's no generation
bookkeeping and no separate liveness monitor. `start`/`stop`/`create` mutually
exclude via OCC on the `workers` doc, and `stop` halts even a suspended loop:
the loop reads the `workers` doc every iteration, so flipping its status to
`stopped` invalidates the suspended loop's read set, waking it to exit.
