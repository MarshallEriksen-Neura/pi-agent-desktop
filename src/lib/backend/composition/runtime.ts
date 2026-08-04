/**
 * This package is the desktop/browser application. Mobile owns an independent
 * composition root and must never call this selector.
 */
export function hasDesktopTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
