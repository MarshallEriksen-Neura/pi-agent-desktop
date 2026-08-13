/**
 * crash-report — 崩溃分类与诊断文本构造。纯函数,无副作用,可单测。
 */

/**
 * 判断错误是否为「动态 import 的 chunk 拉不到」。
 *
 * 这是移动端最常见的崩因,且与代码 bug 无关:APK 更新后 WebView 可能仍持有
 * 旧的 index.html,里面引用的 chunk 文件名(带 hash)在新构建里已不存在,
 * 于是 routes.tsx 里的 lazy() 直接 reject。此时正确的话术是「应用已更新,
 * 重新加载即可」,而不是「发生未知错误」——所以这个判断必须准。
 *
 * 各引擎/浏览器的文案不统一,这里覆盖 Chromium(Android WebView 的引擎)、
 * Safari/WebKit 与 Firefox 的已知措辞。
 */
export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const m = message.toLowerCase();
  return (
    // Chromium / Android WebView
    m.includes("failed to fetch dynamically imported module") ||
    m.includes("error loading dynamically imported module") ||
    // WebKit / iOS
    m.includes("importing a module script failed") ||
    m.includes("unable to load script") ||
    // Firefox
    m.includes("error loading module") ||
    // Vite 预加载助手(vite:preloadError)
    m.includes("failed to fetch module") ||
    m.includes("dynamically imported module") ||
    // 常见于 CSS/JS chunk 404
    m.includes("loading chunk") ||
    m.includes("loading css chunk")
  );
}

/**
 * 构造诊断文本。截断堆栈:WebView 里的 pre 容器就那么高,而且前几帧才有信息量。
 */
export function buildDiagnostics(error: unknown, extra?: Record<string, string>): string {
  const lines: string[] = [];

  if (error instanceof Error) {
    lines.push(`${error.name}: ${error.message}`);
    if (error.stack) {
      const frames = error.stack.split("\n").slice(1, 9);
      if (frames.length) lines.push(frames.join("\n"));
    }
  } else {
    lines.push(String(error));
  }

  for (const [k, v] of Object.entries(extra ?? {})) {
    lines.push(`${k}: ${v}`);
  }

  lines.push(`ua: ${navigator.userAgent}`);
  lines.push(`at: ${new Date().toISOString()}`);

  return lines.join("\n");
}

/** 取错误名用于断口标签。非 Error 抛出物(throw "boom")也要有个能显示的名字。 */
export function errorNameOf(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return "Error";
}

// ----------------------------------------------------------------
// 未捕获异步错误的记录
// ----------------------------------------------------------------

export interface CrashRecord {
  at: number;
  message: string;
  source: "error" | "unhandledrejection";
}

/**
 * 环形缓冲。error boundary 在结构上只能捕获 render 阶段的抛出,而本应用大量
 * 逻辑在 WS / fetch / stream 回调里(net/、stores/),那些异步错误 boundary
 * 一个都接不到——不记录的话就彻底静默。
 *
 * 刻意保持为「记录器」而非「toast 系统」:net/errors.ts 已经把预期内的网络
 * 失败映射成了页面内状态,再弹一层全局提示只会把同一件事说两遍。这里只兜真
 * 正意外的 bug。
 */
const RING_SIZE = 20;
const ring: CrashRecord[] = [];

export function recordCrash(rec: CrashRecord): void {
  ring.push(rec);
  if (ring.length > RING_SIZE) ring.shift();
}

export function getCrashRing(): readonly CrashRecord[] {
  return ring;
}

let installed = false;

/**
 * 安装 window 级兜底。幂等——HMR 下重复调用不会叠加监听器。
 */
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (e) => {
    recordCrash({
      at: Date.now(),
      message: e.message || String(e.error),
      source: "error",
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    recordCrash({
      at: Date.now(),
      message: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
      source: "unhandledrejection",
    });
    // stale chunk 的 reject 常以 unhandledrejection 形式出现(预加载失败),
    // 这类不是 bug,开发时也不必刷屏。
    if (import.meta.env.DEV && !isStaleChunkError(reason)) {
      console.error("[unhandled rejection]", reason);
    }
  });
}
