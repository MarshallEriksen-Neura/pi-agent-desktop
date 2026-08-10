import { memo } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Home, FolderTree, ListChecks, Settings } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { ConnectionBar } from "./ConnectionBar";

/**
 * AppShell — the persistent frame around all tab pages. Renders:
 *  - ConnectionBar (top) — shows the Secure Tether phase, tappable for settings
 *  - Outlet (middle) — the active page
 *  - TabBar (bottom) — 4 tabs, safe-area aware
 *
 * Pages that don't need the shell (Onboarding, Pairing) render outside it
 * via route configuration.
 */

const TABS = [
  { path: "/home", icon: Home, label: "tab.home" },
  { path: "/projects", icon: FolderTree, label: "tab.projects" },
  { path: "/tasks", icon: ListChecks, label: "tab.tasks" },
  { path: "/settings", icon: Settings, label: "tab.settings" },
] as const;

export const AppShell = memo(function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { phase } = useConnection();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        paddingTop: "var(--safe-top)",
      }}
    >
      {/* Connection status bar */}
      <ConnectionBar phase={phase} />

      {/* Page content */}
      <main
        style={{
          flex: 1,
          overflow: "auto",
          paddingBottom: "calc(var(--safe-bottom) + 64px)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <Outlet />
      </main>

      {/* Bottom tab bar */}
      <nav
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "space-around",
          alignItems: "center",
          height: "calc(56px + var(--safe-bottom))",
          paddingBottom: "var(--safe-bottom)",
          background: "color-mix(in srgb, var(--color-bg-base) 85%, transparent)",
          backdropFilter: "blur(20px)",
          borderTop: "1px solid var(--color-separator)",
          zIndex: 10,
        }}
      >
        {TABS.map((tab) => {
          const active = location.pathname.startsWith(tab.path);
          const Icon = tab.icon;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                padding: "8px 16px",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
                color: active ? "var(--color-accent)" : "var(--color-text-tertiary)",
              }}
            >
              <Icon size={22} />
              <span style={{ fontSize: 10, fontWeight: 500 }}>{t(tab.label)}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
});
