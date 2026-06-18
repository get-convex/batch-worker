# Batch Worker

[![npm version](https://badge.fury.io/js/@example%2Fbatch-worker.svg)](https://badge.fury.io/js/@example%2Fbatch-worker)

<!-- START: Include on https://convex.dev/components -->

Run a single background "main loop" over work you insert into your own table —
without scheduling, debouncing, or recovery boilerplate.

You bring two functions:

- a **work query** that returns the next batch of work, or `idle` when the queue
  is empty (optionally with a `timeoutMs` hint for when to look again), and
- a **worker mutation** that processes that batch.

After inserting work, call `worker.ping(...)`. The component takes care of the
rest:

- runs exactly one loop at a time, debouncing bursts so they batch together,
- keeps the loop "warm" with a short polling cooldown so a trickle of new work
  is picked up promptly,
- uses snapshot reads while draining so concurrent inserts don't cause OCC
  retries, and confirms with a real read before going idle so nothing is lost,
- goes idle when the queue drains, and restarts automatically the next time you
  ping,
- monitors the loop and **restarts it if it ever dies** (e.g. an unexpected
  error), logging the failure so you can alert on it.

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
import { BatchWorker, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation } from "./_generated/server";

const worker = new BatchWorker(components.batchWorker);

const BATCH_SIZE = 10;

// Insert work, then make sure the loop is running.
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("events", { value });
    await worker.ping(ctx, {
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

### `ping` vs `start`

- **`ping`** carries the query/mutation + config. It creates the worker on first
  call and resumes it thereafter — call it right after inserting work.
- **`start({ name })`** resumes an existing worker (e.g. after `stop`) using its
  stored query/mutation. No-ops if the worker was never `ping`ed.

### Steering the loop from your worker mutation

Your worker mutation may return `{ debounceMs, timeoutMs }` to throttle the
loop:

```ts
return {
  // Don't run again — and ignore pings — for at least this long (debounce).
  debounceMs: 30_000,
  // Run again by this long from now at the latest. A ping after the debounce
  // window but before the timeout interrupts and runs sooner. Defaults to
  // `debounceMs` (a hard wait with no interruption — good for rate limits).
  timeoutMs: 60_000,
};
```

Similarly, when there's no work your query can return
`{ kind: "idle", timeoutMs }` to sleep until the next item is due instead of
polling — a ping still wakes it immediately.

### Multiple queues

Pass a `name` to run independent workers off the same component instance. The
worker's name is passed to your query as `args.name`:

```ts
await worker.ping(ctx, {
  name: "emails",
  workQuery: internal.email.getBatch,
  workerMutation: internal.email.send,
});
```

### Configuration

Defaults can be set on the `BatchWorker` and overridden per `ping` call:

```ts
const worker = new BatchWorker(components.batchWorker, {
  config: {
    debounceMs: 100, // wait before the first batch so a burst accumulates
    pollIntervalMs: 250, // poll cadence while cooling down
    cooldownMs: 10_000, // keep polling this long after the queue drains
    errorBackoffMs: 60_000, // wait this long to retry after the mutation throws
    monitorLagMs: 90_000, // schedule the liveness monitor this long after the loop
  },
});
```

### Status & stopping

```ts
// In a query:
const status = await worker.status(ctx);
// { kind: "idle" | "running" | "waiting", generation, lastWorkTs, heartbeat } | null

// In a mutation:
await worker.stop(ctx); // halt the loop; start()/ping() resumes it
```

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

| Table         | Written by                          | Read by                 |
| ------------- | ----------------------------------- | ----------------------- |
| `workers`     | `ping`/`start`/`loop` (transitions) | `ping`/`start`, monitor |
| `workerState` | `loop` (every iteration)            | `loop`, monitor         |

The high-churn loop state lives in `workerState`, separate from the rarely-
written `workers` doc (which holds the run-state: `idle` / `running` /
`waiting`). That lets `ping`/`start` — which you call on every insert — read
`workers` and return without conflicting (OCC) with the fast-looping loop. A
monotonic `generation` (in `workerState`) guarantees only one loop chain runs at
a time: a superseded loop sees a mismatched generation and exits. The liveness
monitor is scheduled ~`monitorLagMs` _after_ the loop's next run and pushed back
as the loop keeps running, so it only fires (and restarts the loop) if the loop
actually died.
