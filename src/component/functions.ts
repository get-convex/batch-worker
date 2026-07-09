import {
  customCtx,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import {
  env,
  internalMutation as baseInternalMutation,
  internalQuery as baseInternalQuery,
  mutation as baseMutation,
  query as baseQuery,
  type MutationCtx as BaseMutationCtx,
  type QueryCtx as BaseQueryCtx,
} from "./_generated/server.js";
import { createLogger, type Logger } from "./logging.js";

/**
 * Function builders that read `LOG_LEVEL` from env once at the start of each
 * call and expose a level-aware logger as `ctx.log`. Use these in place of the
 * raw `_generated/server` builders so handlers (and the helpers they call) can
 * just reach for `ctx.log.debug(...)` instead of constructing their own logger.
 */
const withLogger = customCtx(() => ({ log: createLogger(env.LOG_LEVEL) }));

export const query = customQuery(baseQuery, withLogger);
export const internalQuery = customQuery(baseInternalQuery, withLogger);
export const mutation = customMutation(baseMutation, withLogger);
export const internalMutation = customMutation(baseInternalMutation, withLogger);

/**
 * Ctx types for this component's functions: the generated ctx augmented with
 * the `log` logger injected by the builders above. Import these (not the
 * `_generated/server` ones) everywhere so every handler and helper has `ctx.log`.
 */
export type QueryCtx = BaseQueryCtx & { log: Logger };
export type MutationCtx = BaseMutationCtx & { log: Logger };
