import type { NextConfig } from "next";
import path from "node:path";

/**
 * Static export mode — required to pair Next.js with Tauri.
 * Tauri serves static assets, not a Node SSR server.
 */
const isProd = process.env.NODE_ENV === "production";

const nextConfig: NextConfig = {
  output: "export",
  // Tauri loads from a fixed dev server URL; disable image optimization (needs a server)
  images: { unoptimized: true },
  // Emit trailing-slash dirs so file:// / static hosting resolves routes
  trailingSlash: true,
  // Silence multiple-lockfile root inference in this workspace
  outputFileTracingRoot: __dirname,
  assetPrefix: isProd ? undefined : undefined,
  /**
   * `@appica/icons-react` exposes all 4997 icons as named exports off a single
   * root barrel — there are no per-icon subpaths to import from instead. Without
   * this, dev builds resolve the whole barrel on every touch. (lucide-react is
   * already in Next's built-in list; this package is not.)
   */
  experimental: {
    optimizePackageImports: ["@appica/icons-react"],
  },
  webpack: (config) => {
    /**
     * Redirect the bare `shiki` specifier to an explicit language/theme list.
     *
     * `@streamdown/code` (the only importer) reads `bundledLanguages` and
     * `bundledLanguagesInfo` at module scope via `Object.keys()`, so shiki's
     * barrel resists tree-shaking and drags 332 language entries + 65 themes
     * into the graph as emitted chunks. See src/lib/shiki-slim.ts.
     *
     * `$` anchors the alias to the exact request: subpath imports such as
     * `shiki/engine/javascript` (also used by `@streamdown/code`) and
     * `shiki/wasm` must keep resolving to the real package.
     */
    config.resolve.alias = {
      ...config.resolve.alias,
      shiki$: path.resolve(__dirname, "src/lib/shiki-slim.ts"),
    };
    return config;
  },
};

export default nextConfig;
