"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getBackendKind, type BackendKind } from "@/lib/backend/composition/container";
import { hasDesktopTauriRuntime } from "@/lib/backend/composition/runtime";

async function ensureBackendConfigured(): Promise<BackendKind> {
  const desired: BackendKind = hasDesktopTauriRuntime()
    ? "desktop-tauri"
    : "browser-preview";
  const existing = getBackendKind();
  if (existing !== "unconfigured") {
    if (existing !== desired) {
      throw new Error(
        `Backend already configured for ${existing}; refusing to switch to ${desired}.`,
      );
    }
    return existing;
  }

  if (desired === "desktop-tauri") {
    const { installDesktopBackend } = await import(
      "@/lib/backend/composition/desktop"
    );
    if (getBackendKind() === "unconfigured") installDesktopBackend();
  } else {
    const { installBrowserBackend } = await import(
      "@/lib/backend/composition/browser"
    );
    if (getBackendKind() === "unconfigured") installBrowserBackend();
  }

  const configured = getBackendKind();
  if (configured !== desired) {
    throw new Error(`Backend bootstrap resolved ${configured}; expected ${desired}.`);
  }
  return configured;
}

export function BackendProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready" } | { status: "error"; error: Error }
  >({ status: "loading" });

  useEffect(() => {
    let mounted = true;
    void ensureBackendConfigured().then(
      () => mounted && setState({ status: "ready" }),
      (cause) => {
        if (!mounted) return;
        setState({
          status: "error",
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      },
    );
    return () => {
      mounted = false;
    };
  }, []);

  if (state.status === "error") throw state.error;
  if (state.status !== "ready") {
    return <div data-testid="backend-bootstrap" aria-hidden="true" />;
  }
  return <>{children}</>;
}
