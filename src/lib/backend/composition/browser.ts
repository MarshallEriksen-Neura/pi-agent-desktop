import { mockAssetUrlPort } from "../mock/asset-url";
import { mockExternalNavigationPort } from "../mock/external-navigation";
import { mockNotificationPort } from "../mock/notification";
import { mockPetWindowPort } from "../mock/pet-window";
import { createMockPiConfigurationPort } from "../mock/pi-configuration";
import { createMockPiProcessPort } from "../mock/pi-process";
import { createMockProjectCatalogPort } from "../mock/project-catalog";
import { mockProviderAuthPort } from "../mock/provider-auth";
import { createMockRemoteControlPort } from "../mock/remote-control";
import { mockRemoteProviderSyncPort } from "../mock/remote-provider-sync";
import { createMockRemotePiProfilePort } from "../mock/remote-profiles";
import { mockRemoteConversationsPort } from "../mock/remote-conversations";
import { createMockRuntimeConfigPort } from "../mock/runtime-config";
import { createMockSessionRepositoryPort } from "../mock/session-repository";
import { mockUpdaterPort } from "../mock/updater";
import { mockWindowPort } from "../mock/window";
import { createMockWorkspaceFsPort } from "../mock/workspace-fs";
import { createUnsupportedRemoteWorkspaceFsPort } from "../ports/remote-workspace-fs";
import {
  configureBrowserBackend,
  type BackendPorts,
} from "./container";

export function createBrowserBackendPorts(): BackendPorts {
  // One instance, shared by both entries: the mock keeps its documents in
  // memory, so handing out a fresh port per call would silently discard writes.
  const workspaceFs = createMockWorkspaceFsPort();
  return {
    piProcess: createMockPiProcessPort(),
    createPiProcess: (taskId) => createMockPiProcessPort(taskId),
    sessionRepository: createMockSessionRepositoryPort(),
    remoteProfiles: createMockRemotePiProfilePort(),
    remoteProviderSync: mockRemoteProviderSyncPort,
    workspaceFs,
    // The preview has no SSH transport at all, so an SSH binding must refuse
    // here too — resolving it to the mock would make remote browsing look
    // implemented in preview and absent on desktop.
    createWorkspaceFs: (targetId) =>
      targetId && targetId !== "local"
        ? createUnsupportedRemoteWorkspaceFsPort(targetId)
        : workspaceFs,
    projectCatalog: createMockProjectCatalogPort(),
    providerAuth: mockProviderAuthPort,
    remoteControl: createMockRemoteControlPort(),
    remoteConversations: mockRemoteConversationsPort,
    runtimeConfig: createMockRuntimeConfigPort(),
    piConfiguration: createMockPiConfigurationPort(),
    window: mockWindowPort,
    notification: mockNotificationPort,
    updater: mockUpdaterPort,
    assetUrl: mockAssetUrlPort,
    petWindow: mockPetWindowPort,
    externalNavigation: mockExternalNavigationPort,
  };
}

export function installBrowserBackend(): void {
  configureBrowserBackend(createBrowserBackendPorts());
}
