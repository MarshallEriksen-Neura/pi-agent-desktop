import { useUI } from "./store";
import { getPort } from "./backend/composition/container";

/** Hide the main window into the system tray (used by the "minimize" behavior). */
export async function minimizeToTray() {
  try {
    await getPort("window").hide();
  } catch {
    // window may already be hidden or unavailable
  }
}

/**
 * Restore the main window from the system tray — show, unminimize and focus.
 * This is the frontend counterpart to minimizeToTray() and the Rust-side
 * tray-icon click handler. Used by notification click to bring Pi back.
 */
export async function restoreFromTray() {
  try {
    const windowPort = getPort("window");
    await windowPort.show();
    await windowPort.unminimize();
    await windowPort.setFocus();
  } catch {
    // window may be unavailable
  }
}

/** Fully quit the application (used by the "quit" behavior). */
export async function quitApp() {
  try {
    await getPort("window").quit(0);
  } catch {
    window.close();
  }
}

/**
 * Central entry point for any "close" intent — the caption close button,
 * Alt+F4, or the OS native close. Routes to the user's saved behavior:
 * ask (open a dialog), minimize (to tray), or quit.
 */
export function requestClose() {
  const behavior = useUI.getState().closeBehavior;
  if (behavior === "minimize") {
    void minimizeToTray();
  } else if (behavior === "quit") {
    void quitApp();
  } else {
    useUI.getState().setCloseDialogOpen(true);
  }
}
