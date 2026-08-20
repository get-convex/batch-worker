# Changelog

## 0.3.1

- More graceful handling of monitor execution and backoff for wedged workers.
- Cancels and re-schedules a worker if it's "pending" for over a minute.

## 0.3.0

- Provide a worker-persisted cursor to make it easier to implement iterating
  through work using commitTs, which optimizes your queries to skip slow regions
  of the database full of deleted items.
- Introduces `defineBatchWorkerValidators`, deprecates vBatchQueryArgs,
  vBatchResult, etc.
- Requires Convex 1.43+ for v.commitTs() and the new `ctx.runQuery` options.

## 0.2.1 (patch on 0.2.0, not included in 0.3.0)

- More graceful handling of monitor execution and backoff for wedged workers.
- Cancels and re-schedules a worker if it's "pending" for over a minute.

## 0.2.0

- Removes the heartbeat field (breaking)
- Removes the thick client in favor of a standalone `ping` function

## 0.1.0

- Initial release.
