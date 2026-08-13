import { describe, expect, it } from "vitest";
import { buildDiagnostics, errorNameOf, isStaleChunkError } from "@/lib/crash-report";

/**
 * stale-chunk 判断决定用户看到哪句话:「应用已更新，重新加载」还是「界面已停止
 * 响应」。判错就会把一次无害的版本切换说成崩溃(或反过来),所以各引擎的措辞
 * 都要覆盖到。
 */
describe("stale chunk detection", () => {
  it.each([
    // Chromium / Android WebView — 生产环境实际会遇到的那条
    "Failed to fetch dynamically imported module: https://x/assets/TasksPage-a1b2.js",
    "error loading dynamically imported module",
    // WebKit / iOS
    "Importing a module script failed.",
    "Unable to load script",
    // Firefox
    "error loading module",
    // webpack 风格的 chunk 失败
    "Loading chunk 42 failed.",
    "Loading CSS chunk 7 failed",
  ])("recognises %s", (message) => {
    expect(isStaleChunkError(new TypeError(message))).toBe(true);
  });

  it("matches regardless of case", () => {
    expect(isStaleChunkError(new Error("FAILED TO FETCH DYNAMICALLY IMPORTED MODULE"))).toBe(true);
  });

  it("does not flag ordinary render bugs as a stale chunk", () => {
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(
      false,
    );
    expect(isStaleChunkError(new Error("task stream closed"))).toBe(false);
  });

  it("tolerates non-Error throwables", () => {
    expect(isStaleChunkError("boom")).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError({ message: "Loading chunk 3 failed" })).toBe(false);
  });
});

describe("error name for the fracture label", () => {
  it("uses the error name", () => {
    expect(errorNameOf(new TypeError("x"))).toBe("TypeError");
  });

  it("falls back for non-Error throwables so the label is never blank", () => {
    expect(errorNameOf("boom")).toBe("Error");
    expect(errorNameOf(undefined)).toBe("Error");
  });
});

describe("diagnostics text", () => {
  it("leads with name and message, then truncates the stack", () => {
    const error = new Error("kaboom");
    error.stack = ["Error: kaboom", ...Array.from({ length: 20 }, (_, i) => `  at frame${i}`)].join(
      "\n",
    );
    const out = buildDiagnostics(error, { layer: "shell" });

    expect(out.startsWith("Error: kaboom")).toBe(true);
    expect(out).toContain("at frame0");
    expect(out).toContain("layer: shell");
    // 8 帧上限,第 9 帧起丢弃
    expect(out).toContain("at frame7");
    expect(out).not.toContain("at frame8");
  });

  it("handles a thrown non-Error", () => {
    expect(buildDiagnostics("plain string")).toContain("plain string");
  });
});
