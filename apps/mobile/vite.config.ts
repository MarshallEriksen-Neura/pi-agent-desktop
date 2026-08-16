import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  // 版本号从 package.json 注入,而不是在设置页里手写常量 —— 手写的那份
  // 一定会和真实版本分叉,而「关于」页显示错误版本号会让 bug 报告失去意义。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
