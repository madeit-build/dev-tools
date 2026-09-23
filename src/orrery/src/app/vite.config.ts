import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Not 3000, 5173, 8080, or any other contested default: a long-lived local
  // service squatting a popular port invites a future collision.
  server: { port: 31120, strictPort: true },
  resolve: {
    alias: {
      // The model's source, not its compiled CommonJS dist. The app then
      // never depends on a build step having run, and Vite never has to
      // pre-bundle CommonJS into ESM from a cache that can go stale.
      "@made-i-t/orrery-model": fileURLToPath(
        new URL("../model/src/index.ts", import.meta.url),
      ),
    },
  },
});
