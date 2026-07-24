import { exposeDeploymentQuery } from "@convex-dev/static-hosting";
import { components } from "./_generated/api.js";

// Powers the "new version available" reload banner (<UpdateBanner />) after a
// `npm run deploy` ships fresh assets.
export const { getCurrentDeployment } = exposeDeploymentQuery(
  components.staticHosting,
);
