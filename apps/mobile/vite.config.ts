import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5174,
    host: true, // Allow LAN access for on-device testing
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
