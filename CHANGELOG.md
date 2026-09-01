# Changelog

## 0.2.2

- Enfoce a cooldown period whenever the worker starts running, even if the query
  hasn't returned work for a while. Results in more idle loop iterations.

## 0.2.1

- Improve monitor polling behavior around wedged workers.

## 0.2.0

- Removes the heartbeat field (breaking)
- Removes the thick client in favor of a standalone `ping` function

## 0.1.0

- Initial release.
