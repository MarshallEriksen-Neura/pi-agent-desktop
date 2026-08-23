"use client";

import { Component } from "react";

interface State {
  error: Error | null;
  zh: boolean;
}

const buttonBase: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 600,
  fontFamily: "var(--font-ui)",
  borderRadius: 999,
  cursor: "pointer",
};

/**
 * Last-resort boundary around the app shell. Replaces Next's global-error
 * convention, which breaks `output: "export"` builds (vercel/next.js#54239):
 * it catches crashes in the root layout subtree that app/error.tsx can't
 * reach. Kept dependency-free (no stores, no UI kit, no motion) so it can't
 * crash itself; CSS tokens are safe because globals.css ships with the layout.
 */
export class GlobalErrorBoundary extends Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null, zh: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
    // The shell never mounted, so nothing else will dismiss the boot screen —
    // and it would sit on top of this message (see BootScreen).
    try {
      document.documentElement.dataset.appReady = "1";
    } catch {
      // no DOM — nothing to uncover
    }
    try {
      const pref =
        localStorage.getItem("pi-desktop.locale") ?? navigator.language;
      this.setState({ zh: pref.toLowerCase().startsWith("zh") });
    } catch {
      // storage unavailable — keep English
    }
  }

  render() {
    const { error, zh } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          height: "100vh",
          display: "grid",
          placeItems: "center",
          background: "var(--bg-base)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-ui)",
        }}
      >
        <div style={{ textAlign: "center", padding: 24, maxWidth: 400 }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12.5,
              color: "var(--danger)",
              marginBottom: 18,
            }}
          >
            ✗ {zh ? "应用崩溃" : "app crashed"} · {error.name}
          </div>
          <h1 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
            {zh ? "Pi 遇到了严重错误" : "Pi hit a fatal error"}
          </h1>
          <p
            style={{
              margin: "8px 0 20px",
              fontSize: 13,
              lineHeight: 1.55,
              color: "var(--text-secondary)",
            }}
          >
            {zh
              ? "应用外壳渲染失败。重试即可恢复；若持续出现，请重新加载应用。"
              : "The app shell failed to render. Try again to recover — if it keeps happening, reload the app."}
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              onClick={() => this.setState({ error: null })}
              style={{
                ...buttonBase,
                border: "none",
                background: "var(--accent)",
                color: "var(--text-on-accent)",
              }}
            >
              {zh ? "重试" : "Try again"}
            </button>
            <button
              onClick={() => location.reload()}
              style={{
                ...buttonBase,
                border: "1px solid var(--separator)",
                background: "var(--bg-elevated)",
                color: "var(--text-primary)",
              }}
            >
              {zh ? "重新加载" : "Reload app"}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
