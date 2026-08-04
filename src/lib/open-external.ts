"use client";

import { getPort } from "./backend/composition/container";

/** Open an http(s) link in the system browser (Tauri) or a new tab (web dev). */
export function openExternal(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  void getPort("externalNavigation").open(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}
