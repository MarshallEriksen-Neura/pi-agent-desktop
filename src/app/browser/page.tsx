"use client";

import { BrowserPanel } from "@/components/browser/BrowserPanel";
import { useT } from "@/lib/i18n";

export default function BrowserPage() {
  const t = useT();
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "14px 16px 16px",
        gap: 10,
        minHeight: 0,
      }}
    >
      <header>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{t("nav.browser")}</h1>
        <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "2px 0 0" }}>
          {t("browser.idleHint")}
        </p>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <BrowserPanel />
      </div>
    </div>
  );
}
