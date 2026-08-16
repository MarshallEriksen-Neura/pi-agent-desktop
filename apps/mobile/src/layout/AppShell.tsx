import { memo, useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useInteractionStore, selectPendingCount } from "@/stores/interaction-store";
import { setCurrentRoute } from "@/services/route-tracker";
import { onTaskNotificationTap } from "@/services/notifications";
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

/**
 * Tab glyphs are text symbols rather than icon-font components: they render at
 * the platform's own weight, cost nothing to load, and match the reference
 * design. `badge` marks the tab that surfaces a pending count.
 */
const TABS = [
  { path: "/home", glyph: "⌂", label: "tab.home", badge: false },
  { path: "/projects", glyph: "▤", label: "tab.projects", badge: false },
  { path: "/tasks", glyph: "✓", label: "tab.tasks", badge: true },
  { path: "/settings", glyph: "⚙", label: "tab.settings", badge: false },
] as const;

export const AppShell = memo(function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const { phase } = useConnection();
  const pendingCount = useInteractionStore(selectPendingCount);

  // Keep the route mirror current for notification "am I watching this?" checks.
  useEffect(() => {
    setCurrentRoute(location.pathname);
  }, [location.pathname]);

  // Deep-link from notification taps to the task/conversation detail page.
  useEffect(() => {
    return onTaskNotificationTap((route) => {
      navigate(route);
    });
  }, [navigate]);

  // 沉浸式页面:详情页(聊天室)隐藏连接条 + tab bar,消息流独占整屏;
  // compose 表单页和文件预览页同样隐藏两者,让底部操作独占空间。
  const isDetail = /^\/tasks\/[^/]+$/.test(location.pathname);
  const isImmersive = /\/(compose|file)$/.test(location.pathname);
  const hideConnectionBar = isDetail || isImmersive;
  const hideTabBar = isDetail || isImmersive;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        paddingTop: "var(--safe-top)",
      }}
    >
      {/* Connection status bar — 沉浸式页面隐藏 */}
      {!hideConnectionBar && <ConnectionBar phase={phase} />}

      {/* Page content */}
      <main
        style={{
          flex: 1,
          overflow: "auto",
          paddingBottom: hideTabBar
            ? "var(--safe-bottom)"
            : "calc(var(--safe-bottom) + 64px)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <Outlet />
      </main>

      {/* Bottom tab bar — compose 表单页隐藏 */}
      {!hideTabBar && (
        <nav
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "stretch",
          paddingBottom: "var(--safe-bottom)",
          background: "color-mix(in srgb, var(--color-bg-base) 85%, transparent)",
          backdropFilter: "blur(20px)",
          zIndex: 10,
        }}
      >
        {TABS.map((tab) => {
          const active = location.pathname.startsWith(tab.path);
          const showBadge = tab.badge && pendingCount > 0;
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              aria-current={active ? "page" : undefined}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
                // 48px keeps the tap target at the HIG comfort size.
                minHeight: "var(--tap-comfort)",
                padding: "6px 0",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
                color: active ? "var(--color-accent)" : "var(--color-text-tertiary)",
              }}
            >
              <span style={{ position: "relative", fontSize: 21, lineHeight: 1 }}>
                {tab.glyph}
                {showBadge && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: -2,
                      right: -8,
                      minWidth: 15,
                      height: 15,
                      padding: "0 4px",
                      borderRadius: 999,
                      background: "var(--color-status-awaiting)",
                      color: "#fff",
                      fontSize: 9.5,
                      fontWeight: 700,
                      lineHeight: "15px",
                      textAlign: "center",
                    }}
                  >
                    {pendingCount > 9 ? "9+" : pendingCount}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 500 }}>{t(tab.label)}</span>
            </button>
          );
        })}
      </nav>
      )}
    </div>
  );
});
