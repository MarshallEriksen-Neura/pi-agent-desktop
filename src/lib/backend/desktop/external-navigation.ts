import { desktopInvoke } from "./invoke";
import type { ExternalNavigationPort } from "../ports/external-navigation";

export const desktopExternalNavigationPort = {
  open: (url) => desktopInvoke<void>("open_external", { url }),
  // the Rust side validates the extension and builds the file:// URL
  openHtmlFile: (path) => desktopInvoke<void>("open_html_preview", { path }),
} satisfies ExternalNavigationPort;
