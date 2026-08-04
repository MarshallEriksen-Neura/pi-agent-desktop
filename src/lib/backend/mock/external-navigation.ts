import type { ExternalNavigationPort } from "../ports/external-navigation";

export const mockExternalNavigationPort = {
  open: async (url) => {
    window.open(url, "_blank", "noopener,noreferrer");
  },
} satisfies ExternalNavigationPort;
