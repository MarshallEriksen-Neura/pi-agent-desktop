import { getVersion } from "@tauri-apps/api/app";
import { check as checkUpdate } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UpdaterPort } from "../ports/updater";

const REPO_URL = "https://github.com/MarshallEriksen-Neura/pi-agent-desktop";

export const desktopUpdaterPort = {
  getCurrentVersion: () => getVersion(),
  check: async () => {
    const currentVersion = await getVersion();
    const update = await checkUpdate();
    return {
      configured: true,
      repoUrl: REPO_URL,
      currentVersion,
      latestVersion: update ? update.version : currentVersion,
      latestCommit: null,
      updateAvailable: update != null,
    };
  },
  downloadAndInstall: async () => {
    const update = await checkUpdate();
    if (update) await update.downloadAndInstall();
  },
  relaunch,
} satisfies UpdaterPort;
