import { useUI } from "./store";
import { isTauri } from "./pi/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";

/** Hide the main window into the system tray (used by the "minimize" behavior). */
export async function minimizeToTray() {
  if (!isTauri()) return;
  try {
    await getCurrentWindow().hide();
  } catch {
    // window may already be hidden or unavailable
  }
}

/** Fully quit the application (used by the "quit" behavior). */
export async function quitApp() {
  if (isTauri()) {
    try {
      await exit(0);
    } catch {
      // fall back to a hard close if the plugin is unavailable
      window.close();
    }
  } else {
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
