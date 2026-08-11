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
const ProjectsPage = lazy(() => import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const ProjectTreePage = lazy(() => import("@/pages/ProjectTreePage").then((m) => ({ default: m.ProjectTreePage })));
const TaskComposerPage = lazy(() => import("@/pages/TaskComposerPage").then((m) => ({ default: m.TaskComposerPage })));
const TasksPage = lazy(() => import("@/pages/TasksPage").then((m) => ({ default: m.TasksPage })));
const TaskDetailPage = lazy(() => import("@/pages/TaskDetailPage").then((m) => ({ default: m.TaskDetailPage })));
const InteractionsPage = lazy(() => import("@/pages/InteractionsPage").then((m) => ({ default: m.InteractionsPage })));

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
        element: withSuspense(<ProjectsPage />),
      },
      {
        path: "/projects/:projectId/tree",
        element: withSuspense(<ProjectTreePage />),
      },
      {
        path: "/projects/:projectId/compose",
        element: withSuspense(<TaskComposerPage />),
      },
      {
        path: "/tasks",
        element: withSuspense(<TasksPage />),
      },
      {
        path: "/tasks/:taskId",
        element: withSuspense(<TaskDetailPage />),
      },
      {
        path: "/interactions",
        element: withSuspense(<InteractionsPage />),
      },
      {
        path: "/settings",
        element: withSuspense(<SettingsPage />),
      },
    ],
  },
]);
