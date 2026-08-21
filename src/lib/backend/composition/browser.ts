import { mockAssetUrlPort } from "../mock/asset-url";
import { mockExternalNavigationPort } from "../mock/external-navigation";
import { mockNotificationPort } from "../mock/notification";
import { mockPetWindowPort } from "../mock/pet-window";
import { createMockPiConfigurationPort } from "../mock/pi-configuration";
import { createMockPiProcessPort } from "../mock/pi-process";
import { createMockProjectCatalogPort } from "../mock/project-catalog";
import { createMockRemoteControlPort } from "../mock/remote-control";
import { mockRemoteConversationsPort } from "../mock/remote-conversations";
import { createMockRuntimeConfigPort } from "../mock/runtime-config";
import { createMockSessionRepositoryPort } from "../mock/session-repository";
import { mockUpdaterPort } from "../mock/updater";
import { mockWindowPort } from "../mock/window";
import { createMockWorkspaceFsPort } from "../mock/workspace-fs";
import {
  configureBrowserBackend,
  type BackendPorts,
} from "./container";

export function createBrowserBackendPorts(): BackendPorts {
  return {
    piProcess: createMockPiProcessPort(),
    createPiProcess: (taskId) => createMockPiProcessPort(taskId),
    sessionRepository: createMockSessionRepositoryPort(),
    workspaceFs: createMockWorkspaceFsPort(),
    projectCatalog: createMockProjectCatalogPort(),
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
