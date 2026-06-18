#!/usr/bin/env node
// End-to-end performance harness for the worker component.
//
// Drives workloads through the example app's instrumented `e2e` worker
// (see example/convex/e2e.ts) and captures Convex function-execution logs to
// characterize:
//   1. cold-start latency (enqueue -> first processing),
//   2. per-batch overhead while draining a large burst, and
//   3. how many function calls a single isolated execution costs vs. the
//      amortized cost per batch at steady state.
//
// Usage: node e2e.mjs            (runs all scenarios)
// Results + raw logs are written to .context/e2e-results/.

import { ConvexHttpClient } from "convex/browser";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { api } from "./example/convex/_generated/api.js";

const OUT_DIR = ".context/e2e-results";
mkdirSync(OUT_DIR, { recursive: true });

function loadConvexUrl() {
  const env = readFileSync(".env.local", "utf8");
  const m = env.match(/^VITE_CONVEX_URL=(.+)$/m);
  if (!m) throw new Error("VITE_CONVEX_URL not found in .env.local");
  return m[1].trim();
}

const client = new ConvexHttpClient(loadConvexUrl());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- polling helpers -------------------------------------------------------

async function waitIdle(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await client.query(api.e2e.status, {});
    if (!s || s.kind === "idle") return;
    await sleep(150);
  }
  throw new Error("timed out waiting for idle");
}

async function waitDrain(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pending = await client.query(api.e2e.pending, {});
    const s = await client.query(api.e2e.status, {});
    if (pending === 0 && (!s || s.kind === "idle")) return;
    await sleep(150);
  }
  throw new Error("timed out waiting for drain");
}

async function waitForSampleCount(n, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const samples = await client.query(api.e2e.samples, {});
    if (samples.length >= n) return samples;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${n} samples`);
}

// ---- log capture -----------------------------------------------------------

class LogCapture {
  constructor() {
    this.proc = null;
    this.events = [];
  }
  async start() {
    this.proc = spawn("npx", ["convex", "logs", "--jsonl", "--success"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    this.proc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("{")) {
          try {
            this.events.push(JSON.parse(line));
          } catch {
            /* ignore */
          }
        }
      }
    });
    // Give the stream a moment to connect before the workload starts.
    await sleep(2500);
  }
  async stop() {
    await sleep(1500); // let trailing logs flush
    if (this.proc) this.proc.kill("SIGTERM");
    await sleep(300);
    // Dedupe by executionId, keep only Completions.
    const seen = new Set();
    return this.events.filter((e) => {
      if (e.kind !== "Completion") return false;
      if (seen.has(e.executionId)) return false;
      seen.add(e.executionId);
      return true;
    });
  }
}

function countByIdentifier(events, { since, until } = {}) {
  const tally = {};
  for (const e of events) {
    if (since && e.timestamp < since) continue;
    if (until && e.timestamp > until) continue;
    const key = `${e.componentPath ? e.componentPath + "/" : ""}${e.identifier}`;
    const t = (tally[key] ??= {
      count: 0,
      execMs: 0,
      readDocs: 0,
      writeBytes: 0,
    });
    t.count++;
    t.execMs += (e.executionTime ?? 0) * 1000;
    t.readDocs += e.usageStats?.databaseReadDocuments ?? 0;
    t.writeBytes += e.usageStats?.databaseWriteBytes ?? 0;
  }
  return tally;
}

function stats(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: pct(0.5),
    p90: pct(0.9),
    max: sorted[sorted.length - 1],
    mean: +(sum / sorted.length).toFixed(1),
  };
}

// ---- scenarios -------------------------------------------------------------

async function scenarioColdStart() {
  console.log("\n=== Scenario 1: cold-start latency (single item) ===");
  const trials = 10;
  const latencies = [];
  for (let i = 0; i < trials; i++) {
    await client.mutation(api.e2e.reset, {});
    await waitIdle();
    const t0 = Date.now();
    await client.mutation(api.e2e.enqueue, { count: 1 });
    const samples = await waitForSampleCount(1);
    const enqueueToProcess = samples[samples.length - 1].oldestLatencyMs;
    latencies.push(enqueueToProcess);
    console.log(
      `  trial ${i + 1}: enqueue->process = ${enqueueToProcess}ms (client round trip ${Date.now() - t0}ms)`,
    );
  }
  await waitIdle();
  const result = { trials, serverLatencyMs: stats(latencies), latencies };
  console.log(
    "  server-side enqueue->process latency:",
    result.serverLatencyMs,
  );
  return result;
}

async function scenarioBurst(total) {
  console.log(`\n=== Scenario 2: burst of ${total} (per-batch overhead) ===`);
  await client.mutation(api.e2e.reset, {});
  await waitIdle();
  const cap = new LogCapture();
  await cap.start();
  const since = Date.now() / 1000;

  const chunk = 100;
  for (let i = 0; i < total; i += chunk) {
    await client.mutation(api.e2e.enqueue, {
      count: Math.min(chunk, total - i),
    });
  }
  await waitDrain();
  const until = Date.now() / 1000;
  const events = await cap.stop();

  const samples = (await client.query(api.e2e.samples, {})).sort(
    (a, b) => a.processedAt - b.processedAt,
  );
  const batches = samples.length;
  const processedEvents = samples.reduce((a, s) => a + s.batchSize, 0);
  const span = samples[batches - 1].processedAt - samples[0].processedAt;
  const perBatchIntervals = [];
  for (let i = 1; i < samples.length; i++) {
    perBatchIntervals.push(samples[i].processedAt - samples[i - 1].processedAt);
  }
  const tally = countByIdentifier(events, { since, until });

  const result = {
    total,
    processedEvents,
    batches,
    processingSpanMs: Math.round(span),
    throughputPerSec: +((processedEvents / span) * 1000).toFixed(1),
    perBatchIntervalMs: stats(perBatchIntervals),
    batchLatencyMs: stats(samples.map((s) => s.oldestLatencyMs)),
    functionCalls: tally,
  };
  console.log(
    `  ${processedEvents} events in ${batches} batches over ${result.processingSpanMs}ms`,
  );
  console.log(`  throughput: ${result.throughputPerSec} events/s`);
  console.log("  per-batch interval (ms):", result.perBatchIntervalMs);
  console.log("  function calls during burst:");
  for (const [k, v] of Object.entries(tally)) {
    console.log(
      `    ${k}: ${v.count} calls, ${v.execMs.toFixed(0)}ms total exec, ${v.readDocs} docs read`,
    );
  }
  return result;
}

async function scenarioSingleCalls() {
  console.log("\n=== Scenario 3: function calls for ONE isolated item ===");
  await client.mutation(api.e2e.reset, {});
  await waitIdle();
  const cap = new LogCapture();
  await cap.start();
  const since = Date.now() / 1000;

  await client.mutation(api.e2e.enqueue, { count: 1 });
  await waitForSampleCount(1);
  await waitIdle(); // include the full cooldown tail until idle
  await sleep(1000);
  const until = Date.now() / 1000;
  const events = await cap.stop();
  const tally = countByIdentifier(events, { since, until });

  console.log("  function calls for a single enqueue -> idle:");
  for (const [k, v] of Object.entries(tally)) {
    console.log(`    ${k}: ${v.count} calls`);
  }
  return { functionCalls: tally };
}

// ---- main ------------------------------------------------------------------

const results = {};
results.coldStart = await scenarioColdStart();
results.burst1000 = await scenarioBurst(1000);
results.singleItemCalls = await scenarioSingleCalls();

writeFileSync(`${OUT_DIR}/results.json`, JSON.stringify(results, null, 2));
console.log(`\nWrote ${OUT_DIR}/results.json`);
process.exit(0);
