import { v } from "convex/values";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { ping, vBatchQueryArgs, vBatchResult } from "@convex-dev/batch-worker";
import { components, internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server.js";

// Batching async LLM requests, paced by a token budget.
//
// Each request records how many input tokens it will cost. The worker collects
// a batch, reserves that many tokens against a rate limit, and uses the
// returned `retryAfter` to schedule the (async) LLM call for when we're allowed
// to make it. When the call comes back, a mutation writes the responses and
// reserves the output tokens it actually used against the *same* budget — so a
// batch that generates a lot of output naturally delays the next requests.

const WORKER = "llm";

const BATCH_SIZE = 10;

const rateLimiter = new RateLimiter(components.rateLimiter, {
  // One budget for all tokens, input and output. Model it on your provider's
  // tokens-per-minute limit.
  llmTokens: {
    kind: "token bucket",
    rate: 200_000,
    period: MINUTE,
    capacity: 200_000,
  },
});

const worker = {
  name: WORKER,
  workQuery: internal.rateLimited.getBatch,
  workerMutation: internal.rateLimited.startBatch,
  // Wait a beat before the first call so a burst of requests batches together.
  config: { debounceMs: 1000 },
};

/**
 * Submit an LLM request. It's recorded in the table; the worker sends it (with
 * others) in a batch. `inputTokens` is your estimate of the prompt's cost.
 */
export const submitRequest = mutation({
  args: { prompt: v.string(), inputTokens: v.number() },
  handler: async (ctx, { prompt, inputTokens }) => {
    await ctx.db.insert("llmRequests", {
      prompt,
      inputTokens,
      state: "pending",
    });
    await ping(ctx, components.batchWorker, worker);
  },
});

// Carry everything the batch needs — including the prompt — so nothing has to
// go back to the database to re-read it.
const vLlmRequest = v.object({
  id: v.id("llmRequests"),
  prompt: v.string(),
  inputTokens: v.number(),
});

export const getBatch = internalQuery({
  args: vBatchQueryArgs,
  returns: vBatchResult(v.object({ requests: v.array(vLlmRequest) })),
  handler: async (ctx) => {
    // TODO: also pick up "started" requests whose action never reported back
    // (e.g. `startedAt` older than some timeout) so a crashed batch isn't
    // stranded. Left out here to keep the example focused.
    const pending = await ctx.db
      .query("llmRequests")
      .withIndex("state", (q) => q.eq("state", "pending"))
      .take(BATCH_SIZE);
    if (pending.length === 0) {
      return { kind: "idle" as const };
    }
    return {
      kind: "work" as const,
      batch: {
        requests: pending.map((r) => ({
          id: r._id,
          prompt: r.prompt,
          inputTokens: r.inputTokens,
        })),
      },
    };
  },
});

/**
 * Worker mutation: reserve the batch's input-token budget, mark the requests
 * started, and schedule the LLM call for when the budget clears.
 */
export const startBatch = internalMutation({
  args: { requests: v.array(vLlmRequest) },
  handler: async (ctx, { requests }) => {
    const totalInputTokens = requests.reduce((a, r) => a + r.inputTokens, 0);

    // Reserve the whole batch's input tokens up front. `reserve: true` never
    // rejects — it borrows against future capacity — and `retryAfter` is how
    // long until we're back under the limit.
    const { retryAfter } = await rateLimiter.limit(ctx, "llmTokens", {
      count: totalInputTokens,
      reserve: true,
    });

    // Mark them started so getBatch won't hand them out again.
    const startedAt = Date.now();
    for (const { id } of requests) {
      await ctx.db.patch("llmRequests", id, { state: "started", startedAt });
    }

    // Make the actual call when the reservation clears. Pass the prompts
    // through so the action doesn't have to re-read them.
    await ctx.scheduler.runAfter(
      retryAfter ?? 0,
      internal.rateLimited.runBatch,
      {
        prompts: requests.map((r) => ({ id: r.id, prompt: r.prompt })),
      },
    );

    // Don't assemble the next batch until this one's budget is paid off.
    if (retryAfter) {
      return { debounceMs: retryAfter };
    }
    return null;
  },
});

/**
 * The async step: call the LLM for the batch. This is the only piece that has
 * to be an action.
 */
export const runBatch = internalAction({
  args: {
    prompts: v.array(v.object({ id: v.id("llmRequests"), prompt: v.string() })),
  },
  handler: async (ctx, { prompts }) => {
    // --- A real batched LLM call would go here, e.g.: ---
    // const anthropic = new Anthropic();
    // const batch = await anthropic.messages.batches.create({
    //   requests: prompts.map(({ id, prompt }) => ({
    //     custom_id: id,
    //     params: { model, max_tokens, messages: [{ role: "user", content: prompt }] },
    //   })),
    // });
    // ...poll the batch, then map results back to ids...

    // For the example, fake a response + output-token count per request.
    const responses = prompts.map(({ id, prompt }) => ({
      id,
      response: `Echo: ${prompt}`,
      outputTokens: prompt.length,
    }));

    await ctx.runMutation(internal.rateLimited.finishBatch, { responses });
  },
});

/**
 * Write the responses back and account for the output tokens we actually used.
 */
export const finishBatch = internalMutation({
  args: {
    responses: v.array(
      v.object({
        id: v.id("llmRequests"),
        response: v.string(),
        outputTokens: v.number(),
      }),
    ),
  },
  handler: async (ctx, { responses }) => {
    let totalOutputTokens = 0;
    for (const { id, response, outputTokens } of responses) {
      totalOutputTokens += outputTokens;
      await ctx.db.patch("llmRequests", id, {
        state: "finished",
        response,
        outputTokens,
      });
      // Per-response follow-up could go here, e.g.:
      // - await ctx.runMutation(internal.foo.onLlmComplete, { id, response });
      // - kick off a downstream workflow / another batch worker
    }

    // We only learn the output cost after the call, so reserve it now against
    // the same budget — so a batch that generated a lot of output pushes back
    // the next requests, which could only estimate their input cost up front.
    await rateLimiter.limit(ctx, "llmTokens", {
      count: totalOutputTokens,
      reserve: true,
    });

    // No ping needed — finishing doesn't create new pending work; submitRequest
    // wakes the loop when new requests arrive.
  },
});

export const listRequests = query({
  args: {},
  handler: async (ctx) => {
    const requests = await ctx.db.query("llmRequests").take(100);
    return requests.map((r) => ({
      prompt: r.prompt,
      state: r.state,
      response: r.response ?? null,
    }));
  },
});
