import { memo, useEffect } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Folder, House, ListTodo, Settings } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useInteractionStore, selectPendingCount } from "@/stores/interaction-store";
import { InteractionSheet } from "@/components/interaction-sheet";
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
 * The floating tab bar uses the Lucide set already used throughout the mobile
 * surface. `badge` marks the destination that surfaces pending interactions.
 */
const TABS = [
  { path: "/home", icon: House, label: "tab.home", badge: false },
  { path: "/projects", icon: Folder, label: "tab.projects", badge: false },
  { path: "/tasks", icon: ListTodo, label: "tab.tasks", badge: true },
  { path: "/settings", icon: Settings, label: "tab.settings", badge: false },
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
            : "calc(var(--safe-bottom) + var(--floating-tab-offset) + var(--floating-tab-height) + 20px)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <Outlet />
      </main>

      {/* Bottom tab bar — compose 表单页隐藏 */}
      {!hideTabBar && (
        <div className="floating-tab-dock">
          <nav className="floating-tab-bar" aria-label={t("tab.navigation")}>
            {TABS.map((tab) => {
              const active = location.pathname.startsWith(tab.path);
              const showBadge = tab.badge && pendingCount > 0;
              const Icon = tab.icon;

              return (
                <button
                  key={tab.path}
                  type="button"
                  className={`floating-tab-button${active ? " is-active" : ""}`}
                  onClick={() => navigate(tab.path)}
                  aria-current={active ? "page" : undefined}
                  aria-label={
                    showBadge ? t("tab.tasksWithPending", { count: pendingCount }) : t(tab.label)
                  }
                >
                  <span className="floating-tab-icon" aria-hidden="true">
                    <Icon size={20} strokeWidth={active ? 2.35 : 1.9} />
                    {showBadge && (
                      <span className="floating-tab-badge">
                        {pendingCount > 9 ? "9+" : pendingCount}
                      </span>
                    )}
                  </span>
                  <span className="floating-tab-label">{t(tab.label)}</span>
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {/* 交互回答弹层 —— 全局唯一回答面,盖过 tab bar */}
      <InteractionSheet />
    </div>
  );
});
