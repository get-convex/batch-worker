# Convex Worker

[![npm version](https://badge.fury.io/js/@convex-dev%2Fworker.svg)](https://badge.fury.io/js/@convex-dev/worker)

<!-- START: Include on https://convex.dev/components -->

Run a single background "main loop" over work you insert into your own table —
without scheduling, debouncing, or recovery boilerplate.

You bring two functions:

- a **work query** that returns the next batch of work (or `null` when the
  queue is empty), and
- a **worker mutation** that processes that batch.

After inserting work, call `worker.ensureRunning(...)`. The component takes care
of the rest:

- runs exactly one loop at a time, debouncing bursts so they batch together,
- keeps the loop "warm" with a short polling cooldown so a trickle of new work
  is picked up promptly,
- uses snapshot reads while draining so concurrent inserts don't cause OCC
  retries, and confirms with a real read before going idle so nothing is lost,
- goes idle when the queue drains, and restarts automatically the next time you
  enqueue,
- monitors the loop and **restarts it if it ever dies** (e.g. an unexpected
  error), logging the failure so you can alert on it.

This is the pattern behind components like
[Workpool](https://github.com/get-convex/workpool) — extracted so you can build
your own "process a queue" components on top of it.

Found a bug? Feature request?
[File it here](https://github.com/get-convex/worker/issues).

## Installation

Create a `convex.config.ts` file in your app's `convex/` folder and install the
component by calling `use`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import worker from "@convex-dev/worker/convex.config.js";

const app = defineApp();
app.use(worker);

export default app;
```

## Usage

Insert work into your own table, then call `ensureRunning`. Provide a query that
returns the next batch (or `null`) and a mutation that processes it. The query's
return type must match the mutation's args.

```ts
import { v } from "convex/values";
import { Worker } from "@convex-dev/worker";
import { components, internal } from "./_generated/api";
import {
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";

const worker = new Worker(components.worker);

const BATCH_SIZE = 10;

// Insert work, then make sure the loop is running.
export const addEvent = mutation({
  args: { value: v.number() },
  handler: async (ctx, { value }) => {
    await ctx.db.insert("events", { value });
    await worker.ensureRunning(ctx, {
      workQuery: internal.example.getBatch,
      workerMutation: internal.example.processBatch,
      queryArgs: {},
    });
  },
});

// Return the next batch of work, or null when there's nothing to do.
export const getBatch = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("events").take(BATCH_SIZE);
    if (events.length === 0) return null;
    return {
      ids: events.map((e) => e._id),
      values: events.map((e) => e.value),
    };
  },
});

// Process one batch. The worker owns cleanup — delete what you process!
export const processBatch = internalMutation({
  args: { ids: v.array(v.id("events")), values: v.array(v.number()) },
  handler: async (ctx, { ids, values }) => {
    // ... do the work (sum, call an API, schedule downstream jobs, etc.) ...
    for (const id of ids) {
      await ctx.db.delete("events", id);
    }
    // Full batch? There's probably more — run again immediately.
    if (ids.length === BATCH_SIZE) {
      return { runAfter: 0 };
    }
  },
});
```

The component **does not clean up your work for you** — your worker mutation is
responsible for deleting (or marking complete / advancing a cursor past) the
rows it processed, otherwise the next query will return them again.

### Steering the loop from your worker mutation

Your worker mutation may return a `WorkerResult` to influence the loop:

```ts
return {
  // Delay (ms) before the next iteration. Default: run immediately. Return a
  // larger value to back off, e.g. when you hit a rate limit.
  runAfter: 30_000,
  // New args for the next call to your work query — e.g. to advance a cursor
  // when you walk a log instead of deleting rows. Persists across iterations.
  queryArgs: { cursor: nextCursor },
};
```

### Multiple queues

Pass a `name` to run independent workers off the same component instance:

```ts
await worker.ensureRunning(ctx, {
  name: "emails",
  workQuery: internal.email.getBatch,
  workerMutation: internal.email.send,
  queryArgs: {},
});
```

### Configuration

Defaults can be set on the `Worker` and overridden per `ensureRunning` call:

```ts
const worker = new Worker(components.worker, {
  config: {
    debounceMs: 100, // wait before the first batch so a burst accumulates
    pollIntervalMs: 250, // poll cadence while cooling down
    cooldownMs: 10_000, // keep polling this long after the queue drains
    errorBackoffMs: 60_000, // wait this long to retry after the mutation throws
    monitorIntervalMs: 60_000, // how often to check the loop is alive
    logLevel: "REPORT",
  },
});
```

### Status & stopping

```ts
// In a query:
const status = await worker.status(ctx); // { kind: "idle" | "active", ... } | null

// In a mutation:
await worker.stop(ctx); // halt the loop; it restarts on the next enqueue
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

| Table         | Written by                       | Read by                  |
| ------------- | -------------------------------- | ------------------------ |
| `workers`     | `ensureRunning`/`loop` (on idle) | `ensureRunning`, monitor |
| `workerState` | `loop` (every iteration)         | `loop`, monitor          |

The high-churn loop state lives in `workerState`, separate from the rarely-
written `workers` doc. That lets `ensureRunning` — which you call on every
insert — read `workers` and return without conflicting (OCC) with the
fast-looping loop. A monotonic `generation` guarantees only one loop chain runs
at a time: a superseded loop sees a mismatched generation and exits.
