# Changelog

## 0.2.1-alpha.0

- Provide a worker-persisted cursor to make it easier to implement iterating
  through work using commitTs, which optimizes your queries to skip slow regions
  of the database full of deleted items. Requires Convex 1.43+ for v.commitTs()

## 0.2.0

- Removes the heartbeat field (breaking)
- Removes the thick client in favor of a standalone `ping` function

## 0.1.0

- Initial release.
