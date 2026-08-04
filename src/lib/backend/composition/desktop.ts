import { desktopAssetUrlPort } from "../desktop/asset-url";
import { desktopExternalNavigationPort } from "../desktop/external-navigation";
import { desktopNotificationPort } from "../desktop/notification";
import { desktopPetWindowPort } from "../desktop/pet-window";
import { createDesktopPiConfigurationPort } from "../desktop/pi-configuration";
import { createDesktopPiProcessPort } from "../desktop/pi-process";
import { desktopProjectCatalogPort } from "../desktop/project-catalog";
import { createDesktopRuntimeConfigPort } from "../desktop/runtime-config";
import { desktopSessionRepositoryPort } from "../desktop/session-repository";
import { desktopUpdaterPort } from "../desktop/updater";
import { desktopWindowPort } from "../desktop/window";
import { desktopWorkspaceFsPort } from "../desktop/workspace-fs";
import {
  configureDesktopBackend,
  type BackendPorts,
} from "./container";

export function createDesktopBackendPorts(): BackendPorts {
  return {
    piProcess: createDesktopPiProcessPort(),
    sessionRepository: desktopSessionRepositoryPort,
    workspaceFs: desktopWorkspaceFsPort,
    projectCatalog: desktopProjectCatalogPort,
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
