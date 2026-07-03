import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: vite on :5173 proxying /api to the Express backend on :4000
// (override with API_PROXY when the backend runs elsewhere).
// Build: emits straight into ../public, which Express already serves.
const apiTarget = process.env.API_PROXY ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../public",
    emptyOutDir: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/healthz": apiTarget,
    },
  },
});
