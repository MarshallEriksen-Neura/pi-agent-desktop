import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // Polyfill localStorage/navigator for the token-vault dev-browser fallback
    // path exercised by the vault tests. Production Android uses native storage.
    setupFiles: ["tests/setup.ts"],
    // Keep tests fast and isolated — no DOM needed for the pure logic tests.
    pool: "threads",
  },
});
