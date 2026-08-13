import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import { FullScreenSpinner } from "@/components/primitives";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { t } from "@/i18n";
import { AppShell } from "@/layout/AppShell";

// Lazy-load pages so the initial bundle stays small.
const OnboardingPage = lazy(() => import("@/pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage })));
const PairingPage = lazy(() => import("@/pages/PairingPage").then((m) => ({ default: m.PairingPage })));
const HomePage = lazy(() => import("@/pages/HomePage").then((m) => ({ default: m.HomePage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const ProjectsPage = lazy(() => import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const ProjectTreePage = lazy(() => import("@/pages/ProjectTreePage").then((m) => ({ default: m.ProjectTreePage })));
const TaskComposerPage = lazy(() => import("@/pages/TaskComposerPage").then((m) => ({ default: m.TaskComposerPage })));
const TasksPage = lazy(() => import("@/pages/TasksPage").then((m) => ({ default: m.TasksPage })));
const TaskDetailPage = lazy(() => import("@/pages/TaskDetailPage").then((m) => ({ default: m.TaskDetailPage })));
const InteractionsPage = lazy(() => import("@/pages/InteractionsPage").then((m) => ({ default: m.InteractionsPage })));

const withSuspense = (el: React.ReactNode) => (
  <Suspense fallback={<FullScreenSpinner label={t("common.loading")} />}>{el}</Suspense>
);

/**
 * 页面路由的统一构造:Suspense 处理 lazy 的 pending,errorElement 处理它的
 * reject(以及页面自身的渲染崩溃)。两者必须成对出现——只有 Suspense 时
 * chunk 拉取失败会抛穿整个 router。
 *
 * errorElement 一律挂在子路由级别,这样错误渲染在 AppShell 的 Outlet 内,
 * 底部 tab 保持可用;挂到 AppShell 路由上会把壳一起替换掉。
 */
const page = (path: string, el: React.ReactNode) => ({
  path,
  element: withSuspense(el),
  errorElement: <RouteErrorBoundary />,
});

export const router = createBrowserRouter([
  page("/", <OnboardingPage />),
  page("/pair", <PairingPage />),
  {
    element: <AppShell />,
    children: [
      page("/home", <HomePage />),
      page("/projects", <ProjectsPage />),
      page("/projects/:projectId/tree", <ProjectTreePage />),
      page("/projects/:projectId/compose", <TaskComposerPage />),
      page("/tasks", <TasksPage />),
      page("/tasks/:taskId", <TaskDetailPage />),
      page("/interactions", <InteractionsPage />),
      page("/settings", <SettingsPage />),
    ],
  },
]);
