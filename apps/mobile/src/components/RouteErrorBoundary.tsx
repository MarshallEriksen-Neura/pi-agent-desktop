import { memo } from "react";
import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router-dom";
import { t } from "@/i18n";
import { buildDiagnostics, errorNameOf, isStaleChunkError } from "@/lib/crash-report";
import { ErrorStateView } from "./ErrorStateView";

/**
 * RouteErrorBoundary — 挂在各页面路由的 errorElement 上。
 *
 * 覆盖单页渲染崩溃,以及 routes.tsx 里 lazy() 动态 import 的 reject:
 * <Suspense> 只处理 pending,不处理 reject,所以没有这一层时 chunk 拉不到
 * 会直接抛穿到 layer 1,整个应用陪葬。
 *
 * 关键是它必须挂在**子路由**上而不是 AppShell 路由上:挂在父级会把 AppShell
 * 一起替换掉,底部 tab 随之消失,用户被困在错误页。挂在子级则错误渲染在
 * Outlet 里,ConnectionBar 与 tab 都还活着,用户能自己切走——这也是它相比
 * layer 1 用 inline 卡片而非全屏的原因:壳没塌,别演得像塌了。
 */
export const RouteErrorBoundary = memo(function RouteErrorBoundary() {
  const error = useRouteError();
  const navigate = useNavigate();

  // 404 等 Response 型错误:不是崩溃,不该显示断裂的 tether
  if (isRouteErrorResponse(error)) {
    return (
      <ErrorStateView
        variant="inline"
        tone="neutral"
        deskAlive={false}
        errorName={`HTTP ${error.status}`}
        title={t("crash.routeNotFoundTitle")}
        detail={t("crash.routeNotFoundDetail")}
        actions={[
          { label: t("crash.backToTasks"), onClick: () => navigate("/tasks"), variant: "primary" },
        ]}
      />
    );
  }

  const stale = isStaleChunkError(error);

  return (
    <ErrorStateView
      variant="inline"
      tone={stale ? "stale" : "crashed"}
      errorName={stale ? t("crash.staleChunkName") : errorNameOf(error)}
      title={stale ? t("crash.staleChunkTitle") : t("crash.routeTitle")}
      detail={stale ? t("crash.staleChunkDetail") : t("crash.routeDetail")}
      diagnostics={buildDiagnostics(error, { layer: "route" })}
      actions={
        stale
          ? [{ label: t("crash.reload"), onClick: () => location.reload(), variant: "primary" }]
          : [
              { label: t("crash.backToTasks"), onClick: () => navigate("/tasks"), variant: "primary" },
              { label: t("crash.reload"), onClick: () => location.reload(), variant: "outline" },
            ]
      }
    />
  );
});
