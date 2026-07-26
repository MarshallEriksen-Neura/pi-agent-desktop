import type { NextConfig } from "next";

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
};

export default nextConfig;
