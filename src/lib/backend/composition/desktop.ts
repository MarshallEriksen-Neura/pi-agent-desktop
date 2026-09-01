import { desktopAssetUrlPort } from "../desktop/asset-url";
import { desktopExternalNavigationPort } from "../desktop/external-navigation";
import { desktopFileDropPort } from "../desktop/file-drop";
import { desktopNotificationPort } from "../desktop/notification";
import { desktopPetWindowPort } from "../desktop/pet-window";
import { createDesktopPiConfigurationPort } from "../desktop/pi-configuration";
import { createDesktopPiProcessPort } from "../desktop/pi-process";
import { desktopProjectCatalogPort } from "../desktop/project-catalog";
import { createDesktopProviderAuthPort } from "../desktop/provider-auth";
import { desktopRemoteControlPort } from "../desktop/remote-control";
import { desktopRemoteProviderSyncPort } from "../desktop/remote-provider-sync";
import { desktopRemotePiProfilePort } from "../desktop/remote-profiles";
import { desktopRemoteTerminalPort } from "../desktop/remote-terminal";
import { desktopRemoteConversationsPort } from "../desktop/remote-conversations";
import { createDesktopRuntimeConfigPort } from "../desktop/runtime-config";
import { desktopSessionRepositoryPort } from "../desktop/session-repository";
import { desktopUpdaterPort } from "../desktop/updater";
import { desktopWindowPort } from "../desktop/window";
import { desktopWorkspaceFsPort } from "../desktop/workspace-fs";
import { createDesktopRemoteWorkspaceFsPort } from "../desktop/remote-workspace-fs";
import {
  configureDesktopBackend,
  type BackendPorts,
} from "./container";

export function createDesktopBackendPorts(): BackendPorts {
  return {
    piProcess: createDesktopPiProcessPort(),
    createPiProcess: (taskId, executionBinding) => createDesktopPiProcessPort(taskId, executionBinding),
    sessionRepository: desktopSessionRepositoryPort,
    workspaceFs: desktopWorkspaceFsPort,
    // An SSH binding never resolves to the local bridge, so a remote path cannot
    // reach the local filesystem even if a caller forgets to check the target. The
    // read half is real as of V2.3; the mutating half still refuses until V2.4
    // adds the hash check a remote write needs.
    createWorkspaceFs: (targetId) =>
      targetId && targetId !== "local"
        ? createDesktopRemoteWorkspaceFsPort(targetId)
        : desktopWorkspaceFsPort,
    projectCatalog: desktopProjectCatalogPort,
    providerAuth: createDesktopProviderAuthPort(),
    remoteControl: desktopRemoteControlPort,
    remoteProfiles: desktopRemotePiProfilePort,
    remoteTerminal: desktopRemoteTerminalPort,
    remoteProviderSync: desktopRemoteProviderSyncPort,
    remoteConversations: desktopRemoteConversationsPort,
    runtimeConfig: createDesktopRuntimeConfigPort(),
    piConfiguration: createDesktopPiConfigurationPort(),
    window: desktopWindowPort,
    notification: desktopNotificationPort,
    updater: desktopUpdaterPort,
    assetUrl: desktopAssetUrlPort,
    petWindow: desktopPetWindowPort,
    externalNavigation: desktopExternalNavigationPort,
    fileDrop: desktopFileDropPort,
  };
}

export function installDesktopBackend(): void {
  configureDesktopBackend(createDesktopBackendPorts());
}
