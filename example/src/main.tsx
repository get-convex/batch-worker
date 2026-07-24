import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getConvexUrl } from "@convex-dev/static-hosting";
import App from "./App.jsx";
import "./index.css";

// In dev, Vite injects VITE_CONVEX_URL. When served from `*.convex.site` via
// static hosting, derive the backend URL from the current origin instead.
const address = import.meta.env.VITE_CONVEX_URL ?? getConvexUrl();

const convex = new ConvexReactClient(address);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexProvider client={convex}>
      <App />
    </ConvexProvider>
  </StrictMode>,
);
