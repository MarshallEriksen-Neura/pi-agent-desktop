"use client";

/**
 * Defer non-essential startup work until after the current screen has painted
 * and the main thread has a gap.
 *
 * Anything scheduled here is work the first screen must not wait on — a second
 * webview, a background catalog fetch, a warm-up request. Running it straight
 * from a mount effect competes with hydration and first paint even when the work
 * itself is async, because the kickoff (and its IPC/fetch setup) still lands in
 * the same busy stretch.
 *
 * Returns a cancel function for effect cleanup. Cancelling only disarms the
 * task — the already-queued callback still fires, but does nothing.
 */
export function runWhenIdle(
  task: () => void,
  { timeout = 3000 }: { timeout?: number } = {},
): () => void {
  let cancelled = false;
  const run = () => {
    if (!cancelled) task();
  };

  if (typeof window === "undefined") {
    return () => {
      cancelled = true;
    };
  }

  // A single rAF fires *before* the next paint; the nested one lands after it,
  // so the task can never be what delays the frame the user is waiting for.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === "function") {
        // `timeout` is the ceiling, not the target: startup keeps the thread busy
        // enough that a pure idle slot may never arrive.
        window.requestIdleCallback(run, { timeout });
        return;
      }
      // WKWebView (macOS) had no requestIdleCallback until Safari 17.4 — a
      // macrotask after paint is close enough to "out of the first-screen burst".
      window.setTimeout(run, Math.min(timeout, 1200));
    }),
  );

  return () => {
    cancelled = true;
  };
}
