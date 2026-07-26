"use client";

import { isTauri } from "./pi/client";

/** Open an http(s) link in the system browser (Tauri) or a new tab (web dev). */
export function openExternal(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  if (isTauri()) {
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("open_external", { url }).catch(() => {})
    );
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
