import type {
  LauncherCapabilities,
  LauncherInstallResult,
  LauncherUpgradeResult,
  RemotePiProfile,
  RemotePiProfileInput,
  RemoteReadinessReport,
} from "../ports/execution-target";
import type { RemotePiProfilePort } from "../ports/remote-profiles";
import type { RemoteTaskHandle, RemoteTaskReport } from "../ports/remote-profiles";
import { desktopInvoke } from "./invoke";

export const desktopRemotePiProfilePort: RemotePiProfilePort = {
  list: () => desktopInvoke<RemotePiProfile[]>("remote_profiles_list"),
  save: (profile: RemotePiProfileInput) =>
    desktopInvoke<RemotePiProfile>("remote_profile_save", { profile }),
  delete: (id: string) => desktopInvoke<void>("remote_profile_delete", { id }),
  preflight: (id: string) =>
    desktopInvoke<RemoteReadinessReport>("remote_profile_preflight", { id }),
  checkDraft: (profile: RemotePiProfileInput) =>
    desktopInvoke<RemoteReadinessReport>("remote_profile_check_draft", { profile }),
  installLauncher: (host: string, launcherPath?: string) =>
    desktopInvoke<LauncherInstallResult>("remote_profile_install_launcher", {
      host,
      launcherPath: launcherPath ?? null,
    }),
  capabilities: (id: string) =>
    desktopInvoke<LauncherCapabilities>("remote_profile_capabilities", { id }),
  autoUpgradeLauncher: (id: string) =>
    desktopInvoke<LauncherUpgradeResult>("remote_launcher_autoupgrade", { id }),
  ensureTask: (request) =>
    desktopInvoke<RemoteTaskHandle>("remote_task_ensure", {
      profileId: request.profileId,
      remoteTaskId: request.remoteTaskId ?? null,
      remoteCwd: request.remoteCwd,
      resumePath: request.resumePath ?? null,
    }),
  taskStatus: (profileId: string, remoteTaskId: string) =>
    desktopInvoke<RemoteTaskReport>("remote_task_status", { profileId, remoteTaskId }),
  stopTask: (profileId: string, remoteTaskId: string) =>
    desktopInvoke<RemoteTaskReport>("remote_task_stop", { profileId, remoteTaskId }),
  reapTasks: (profileId: string) =>
    desktopInvoke<unknown>("remote_task_reap", { profileId }),
  sshConfigHosts: () => desktopInvoke<string[]>("ssh_config_hosts"),
};
