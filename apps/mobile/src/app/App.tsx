import { RouterProvider } from "react-router-dom";
import { router } from "./routes";

/**
 * Root component — mounts the router. The connection store auto-loads
 * the stored connection and attempts to connect on first render (via
 * useConnection in AppShell / OnboardingPage).
 */
export function App() {
  return <RouterProvider router={router} />;
}
