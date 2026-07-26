import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";

export const metadata: Metadata = {
  title: "Pi — Coding Agent",
  description: "iOS-inspired desktop client for the Pi coding agent",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // default to dark for the immersive coding surface (.dark also drives Appica UI)
    <html lang="en" data-theme="dark" className="dark" suppressHydrationWarning>
      <body>
        {/* app-level last resort — Next's global-error breaks output:"export" */}
        <GlobalErrorBoundary>
          <AppShell>{children}</AppShell>
        </GlobalErrorBoundary>
      </body>
    </html>
  );
}
