import { convexToJson, jsonToConvex, type Value } from "convex/values";

declare const Convex: {
  asyncSyscall: (op: string, jsonArgs: string) => Promise<string>;
};

/**
 * Run a query (by function handle) without creating a read dependency.
 * Concurrent writes to the data the query reads will NOT cause the calling
 * mutation to retry via OCC.
 *
 * Tradeoff: a concurrent transaction that hasn't yet committed at snapshot
 * time may insert data this query won't see. The worker loop relies on this
 * to scan for work cheaply while it's actively processing; before it goes
 * idle it re-runs the query with a real dependency (plain `ctx.runQuery`) so
 * a racing insert forces it to notice the new work.
 */
export async function runSnapshotQuery(
  functionHandle: string,
  args: Record<string, Value>,
): Promise<Value> {
  const syscallArgs = {
    udfType: "snapshotQuery",
    functionHandle,
    args: convexToJson(args),
  };
  const resultStr = await Convex.asyncSyscall(
    "1.0/runUdf",
    JSON.stringify(syscallArgs),
  );
  return jsonToConvex(JSON.parse(resultStr));
}
