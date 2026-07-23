import { defineApp } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const app = defineApp();
app.use(batchWorker);
// Used by the rate-limited worker example in rateLimited.ts.
app.use(rateLimiter);

export default app;
