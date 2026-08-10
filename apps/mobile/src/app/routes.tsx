import { lazy, Suspense } from "react";
import { createBrowserRouter } from "react-router-dom";
import { FullScreenSpinner } from "@/components/primitives";
import { t } from "@/i18n";
import { AppShell } from "@/layout/AppShell";

// Lazy-load pages so the initial bundle stays small.
const OnboardingPage = lazy(() => import("@/pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage })));
const PairingPage = lazy(() => import("@/pages/PairingPage").then((m) => ({ default: m.PairingPage })));
const HomePage = lazy(() => import("@/pages/HomePage").then((m) => ({ default: m.HomePage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));

// Placeholder pages for Projects/Tasks (Phase 6)
const ProjectsPlaceholder = () => (
  <div style={{ padding: 16 }}>
    <h1 style={{ fontSize: 28, fontWeight: 700, margin: "8px 0" }}>{t("home.projects")}</h1>
    <p style={{ color: "var(--color-text-tertiary)", fontSize: 14 }}>
      项目列表将在下一阶段实现。
    </p>
  </div>
);
const TasksPlaceholder = () => (
  <div style={{ padding: 16 }}>
    <h1 style={{ fontSize: 28, fontWeight: 700, margin: "8px 0" }}>{t("home.tasks")}</h1>
    <p style={{ color: "var(--color-text-tertiary)", fontSize: 14 }}>
      任务列表将在下一阶段实现。
    </p>
  </div>
);

const withSuspense = (el: React.ReactNode) => (
  <Suspense fallback={<FullScreenSpinner label={t("common.loading")} />}>{el}</Suspense>
);

export const router = createBrowserRouter([
  {
    path: "/",
    element: withSuspense(<OnboardingPage />),
  },
  {
    path: "/pair",
    element: withSuspense(<PairingPage />),
  },
  {
    element: <AppShell />,
    children: [
      {
        path: "/home",
        element: withSuspense(<HomePage />),
      },
      {
        path: "/projects",
        element: <ProjectsPlaceholder />,
      },
      {
        path: "/tasks",
        element: <TasksPlaceholder />,
      },
      {
        path: "/settings",
        element: withSuspense(<SettingsPage />),
      },
    ],
  },
]);
