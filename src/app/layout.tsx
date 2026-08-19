import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond } from "next/font/google";
import "./globals.css";
import "streamdown/styles.css";
import { AppShell } from "@/components/AppShell";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import { BackendProvider } from "@/components/BackendProvider";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["italic"],
  variable: "--font-cormorant",
});

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

/**
 * Resolve the theme before first paint. The markup below ships `dark` because a
 * static export has no request-time signal, so without this a light-OS user
 * would see a dark flash until initTheme() runs after hydration. Kept tiny and
 * inline — it must execute before the body paints. Mirrors store.ts: a pinned
 * `pi-desktop.theme` wins, otherwise follow the OS.
 */
const THEME_BOOTSTRAP = `(function(){try{
var s=null;try{s=localStorage.getItem("pi-desktop.theme")}catch(e){}
var t=(s==="light"||s==="dark")?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches===false?"light":"dark");
var e=document.documentElement;e.setAttribute("data-theme",t);
e.classList.toggle("dark",t==="dark");e.classList.toggle("light",t==="light");
}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // dark is the SSR default (see THEME_BOOTSTRAP); .dark also drives Appica UI
    <html lang="en" data-theme="dark" className={`dark ${cormorant.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {/* app-level last resort — Next's global-error breaks output:"export" */}
        <GlobalErrorBoundary>
          <BackendProvider>
            <AppShell>{children}</AppShell>
          </BackendProvider>
        </GlobalErrorBoundary>
      </body>
    </html>
  );
}
