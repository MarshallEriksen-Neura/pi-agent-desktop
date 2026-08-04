import pkg from "../../../../package.json";
import type { UpdaterPort } from "../ports/updater";

const REPO_URL = "https://github.com/MarshallEriksen-Neura/pi-agent-desktop";

export const MOCK_APPLY_ERROR = "mock-preview";

export const mockUpdaterPort = {
  getCurrentVersion: async () => pkg.version,
  check: async () => ({
    configured: true,
    repoUrl: REPO_URL,
    currentVersion: pkg.version,
    latestVersion: "v0.2.0",
    latestCommit: "9f3ab12",
    updateAvailable: true,
  }),
  downloadAndInstall: async () => {
    throw new Error(MOCK_APPLY_ERROR);
  },
  relaunch: async () => undefined,
} satisfies UpdaterPort;
