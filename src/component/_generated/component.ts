/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      ping: FunctionReference<
        "mutation",
        "internal",
        {
          config?: {
            debounceMs?: number;
            errorBackoffMs?: number;
            monitorLagMs?: number;
          };
          name: string;
          workQuery: string;
          workerMutation: string;
        },
        null,
        Name
      >;
      start: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        null,
        Name
      >;
      status: FunctionReference<
        "query",
        "internal",
        { name: string },
        null | {
          generation: bigint;
          heartbeat: number;
          kind: "idle" | "running" | "waiting";
          lastWorkTs: number;
        },
        Name
      >;
      stop: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        null,
        Name
      >;
    };
  };
