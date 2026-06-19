import { expect, test } from "vitest";
import {
  internalMutationGeneric,
  internalQueryGeneric,
} from "convex/server";
import { v } from "convex/values";
import type {
  BatchResult,
  ConfigOverrides,
  WorkerResult,
} from "./index.js";
import { vBatchQueryArgs, vBatchResult, vWorkerResult } from "./index.js";

const workResult: BatchResult<{ ids: string[] }> = {
  kind: undefined,
  batch: { ids: [] },
};

const idleResult: BatchResult<{ ids: string[] }> = {
  kind: "idle",
  cooldownMs: undefined,
  pollIntervalMs: undefined,
  timeoutMs: undefined,
};

const workerResult: WorkerResult = {
  debounceMs: undefined,
};

const configOverrides: ConfigOverrides = {
  debounceMs: undefined,
  monitorLagMs: undefined,
};

const workQuery = internalQueryGeneric({
  args: vBatchQueryArgs,
  returns: vBatchResult(v.object({ ids: v.array(v.string()) })),
  handler: async () => ({
    kind: "idle" as const,
    cooldownMs: undefined,
    pollIntervalMs: undefined,
    timeoutMs: undefined,
  }),
});

const workerMutation = internalMutationGeneric({
  args: { ids: v.array(v.string()) },
  returns: vWorkerResult,
  handler: async () => ({
    debounceMs: undefined,
  }),
});

test("optional public types allow explicit undefined", () => {
  expect([
    workResult,
    idleResult,
    workerResult,
    configOverrides,
    workQuery,
    workerMutation,
  ]).toHaveLength(6);
});
