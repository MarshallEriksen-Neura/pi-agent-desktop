import { RouterProvider } from "react-router-dom";
import { router } from "./routes";
import { ensureNotificationPermission } from "@/services/notifications";

/**
 * Root component — mounts the router. The connection store auto-loads
 * the stored connection and attempts to connect on first render (via
 * useConnection in AppShell / OnboardingPage).
 *
 * Notification permission is requested once at startup (Android 13+
 * shows a system prompt); denial falls back to in-app-only behavior.
 */
void ensureNotificationPermission();

export function App() {
  return <RouterProvider router={router} />;
}
