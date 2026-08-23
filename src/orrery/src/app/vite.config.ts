import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Not 3000, 5173, 8080, or any other contested default: a long-lived local
  // service squatting a popular port invites a future collision.
  server: { port: 31120, strictPort: true },
  optimizeDeps: {
    // The model package is CommonJS, matching every other package in this
    // repo. Vite skips pre-bundling for workspace-linked deps by default, and
    // an ESM app cannot take named imports from raw CJS, so it must be named
    // explicitly or every import from the model fails at runtime.
    include: ["@made-i-t/orrery-model"],
  },
  build: {
    commonjsOptions: { include: [/orrery-model/, /node_modules/] },
  },
});
