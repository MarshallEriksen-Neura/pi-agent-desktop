"use client";

import { getPort } from "./backend/composition/container";

/** Open an http(s) link in the system browser (Tauri) or a new tab (web dev). */
export function openExternal(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  void getPort("externalNavigation").open(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

/**
 * Open a local .html/.htm file in the system browser. The desktop port rejects
 * non-HTML targets, so on failure there is no web fallback — a file:// URL
 * opened from the dev web page is blocked by the browser anyway.
 *
 * A rejection is logged rather than dropped. This button's whole failure mode is
 * looking broken: the file is gone, or the command refuses the path, and a
 * swallowed error leaves a click that does nothing and says nothing.
 */
export function openHtmlFile(path: string) {
  void getPort("externalNavigation")
    .openHtmlFile(path)
    .catch((cause) => {
      console.error("[openHtmlFile] could not open %s:", path, cause);
    });
}
