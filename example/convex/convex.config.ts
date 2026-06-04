import { defineApp } from "convex/server";
import worker from "@convex-dev/worker/convex.config.js";

const app = defineApp();
app.use(worker);

export default app;
