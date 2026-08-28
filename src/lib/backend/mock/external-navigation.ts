import type { ExternalNavigationPort } from "../ports/external-navigation";

/** path → file:// URL, close enough to the desktop command for web dev. */
function toFileUrl(path: string): string {
  return "file:///" + encodeURI(path.replace(/\\/g, "/")).replace(/^\/+/, "");
}

export const mockExternalNavigationPort = {
  open: async (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
  openHtmlFile: async (path) => {
    window.open(toFileUrl(path), "_blank", "noopener,noreferrer");
  },
} satisfies ExternalNavigationPort;
