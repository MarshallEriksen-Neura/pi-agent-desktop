import { desktopInvoke } from "./invoke";
import type { ExternalNavigationPort } from "../ports/external-navigation";

export const desktopExternalNavigationPort = {
  open: (url) => desktopInvoke<void>("open_external", { url }),
} satisfies ExternalNavigationPort;
