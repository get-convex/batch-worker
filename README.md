# Batch Worker

[![npm version](https://badge.fury.io/js/@convex-dev%2Fbatch-worker.svg)](https://badge.fury.io/js/@convex-dev/batch-worker)

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
- keeps the loop "warm" with a polling cooldown (controlled by your query) so a
  trickle of new work is picked up promptly,
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
      // Cooldown/poll/timeout are returned here, not configured statically.
      return { kind: "idle" as const };
      // e.g. poll every 250ms for 10s, then sleep until the next item is due:
      // return { kind: "idle" as const, pollIntervalMs: 250, cooldownMs: 10_000, timeoutMs: 30_000 };
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

### Steering the loop dynamically

Most of the loop's pacing is returned from your functions, not configured
statically:

- **Your worker mutation** may return `{ debounceMs }` to throttle — the loop
  won't run again (and ignores pings) for that long. Returning nothing re-runs
  immediately to drain the rest.

  ```ts
  return { debounceMs: 30_000 }; // e.g. back off after hitting a rate limit
  ```

- **Your work query**, on `idle`, controls the cooldown and the eventual sleep:

  ```ts
  return {
    kind: "idle" as const,
    pollIntervalMs: 250, // re-check this often while cooling down
    cooldownMs: 10_000, // keep polling this long after the last work
    timeoutMs: 30_000, // then sleep at most this long (e.g. next item's ETA)
  };
  ```

  After the cooldown, with no `timeoutMs` the loop goes fully idle (only a
  `ping`/`start` wakes it); with one, it sleeps until then — and a `ping` wakes
  it sooner.

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

The static config is small (most pacing is returned dynamically — see above).
Defaults can be set on the `BatchWorker` and overridden per `ping` call:

```ts
const worker = new BatchWorker(components.batchWorker, {
  config: {
    debounceMs: 0, // wait before the first batch so a burst accumulates
    errorBackoffMs: 60_000, // wait this long to retry after the mutation throws
    monitorLagMs: 60_000, // schedule the liveness monitor this long after the loop
  },
});
```

Log level is set via the component's `LOG_LEVEL` env var (see Installation).

### Status & stopping

```ts
// In a query:
const status = await worker.status(ctx);
// { kind: "idle" | "running" | "stopped" } | null

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

The high-churn loop state lives in `workerState` (generation, heartbeat, the
scheduled runner, and the monitor), separate from the rarely-written `workers`
doc (which holds the handles, config, and run-status: `idle` / `running` /
`stopped`, plus a pointer to its `workerState`). That lets `ping`/`start` —
which you call on every insert — read `workers` and return without conflicting
(OCC) with the fast-looping loop. A monotonic `generation` (in `workerState`)
guarantees only one loop chain runs at a time: a superseded loop sees a
mismatched generation and exits. `workerState` is looked up by id and
re-created if it's ever missing. The liveness monitor is scheduled
~`monitorLagMs` _after_ the loop's next run and pushed back as the loop keeps
running, so it only fires (and restarts the loop) if the loop actually died.
