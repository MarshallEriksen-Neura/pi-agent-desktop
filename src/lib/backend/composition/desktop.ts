import { desktopAssetUrlPort } from "../desktop/asset-url";
import { desktopExternalNavigationPort } from "../desktop/external-navigation";
import { desktopNotificationPort } from "../desktop/notification";
import { desktopPetWindowPort } from "../desktop/pet-window";
import { createDesktopPiConfigurationPort } from "../desktop/pi-configuration";
import { createDesktopPiProcessPort } from "../desktop/pi-process";
import { desktopProjectCatalogPort } from "../desktop/project-catalog";
import { createDesktopProviderAuthPort } from "../desktop/provider-auth";
import { desktopRemoteControlPort } from "../desktop/remote-control";
import { desktopRemoteProviderSyncPort } from "../desktop/remote-provider-sync";
import { desktopRemotePiProfilePort } from "../desktop/remote-profiles";
import { desktopRemoteConversationsPort } from "../desktop/remote-conversations";
import { createDesktopRuntimeConfigPort } from "../desktop/runtime-config";
import { desktopSessionRepositoryPort } from "../desktop/session-repository";
import { desktopUpdaterPort } from "../desktop/updater";
import { desktopWindowPort } from "../desktop/window";
import { desktopWorkspaceFsPort } from "../desktop/workspace-fs";
import { createUnsupportedRemoteWorkspaceFsPort } from "../ports/remote-workspace-fs";
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
    // An SSH binding resolves to a port that refuses every call rather than to
    // the local bridge, so a remote path cannot reach the local filesystem even
    // if a caller forgets to check the target. V2.3 replaces the read half.
    createWorkspaceFs: (targetId) =>
      targetId && targetId !== "local"
        ? createUnsupportedRemoteWorkspaceFsPort(targetId)
        : desktopWorkspaceFsPort,
    projectCatalog: desktopProjectCatalogPort,
    providerAuth: createDesktopProviderAuthPort(),
    remoteControl: desktopRemoteControlPort,
    remoteProfiles: desktopRemotePiProfilePort,
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
  };
}

export function installDesktopBackend(): void {
  configureDesktopBackend(createDesktopBackendPorts());
}
