import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond } from "next/font/google";
import "./globals.css";
import "streamdown/styles.css";
import { AppShell } from "@/components/AppShell";
import { BootScreen } from "@/components/BootScreen";
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
 * Pre-paint bootstrap. Both jobs must happen before the body paints, so this
 * stays tiny and inline.
 *
 * 1. Theme: the markup below ships `dark` because a static export has no
 *    request-time signal, so without this a light-OS user would see a dark flash
 *    until initTheme() runs after hydration. Mirrors store.ts: a pinned
 *    `pi-desktop.theme` wins, otherwise follow the OS.
 * 2. Shell kind: the pet companion renders through this same layout in its own
 *    200x250 transparent window, where the boot screen would be nonsense.
 *    Marking the shell here (rather than in React) keeps the boot screen out of
 *    that window's very first paint.
 */
const PRE_PAINT_BOOTSTRAP = `(function(){try{
var s=null;try{s=localStorage.getItem("pi-desktop.theme")}catch(e){}
var t=(s==="light"||s==="dark")?s:(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches===false?"light":"dark");
var e=document.documentElement;e.setAttribute("data-theme",t);
e.classList.toggle("dark",t==="dark");e.classList.toggle("light",t==="light");
var p=location.pathname;
e.setAttribute("data-shell",(p==="/pet"||p.indexOf("/pet/")===0)?"pet":"app");
}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // dark is the SSR default (see PRE_PAINT_BOOTSTRAP); .dark also drives Appica UI
    <html lang="en" data-theme="dark" className={`dark ${cormorant.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PRE_PAINT_BOOTSTRAP }} />
      </head>
      <body>
        {/* Paints the chrome's shape before any JS runs — the shell below is
            empty until BackendProvider resolves on the client. */}
        <BootScreen />
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
