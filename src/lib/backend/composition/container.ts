import type {
  AssetUrlPort,
  ExternalNavigationPort,
  NotificationPort,
  PetWindowPort,
  PiConfigurationPort,
  PiProcessPort,
  ProjectCatalogPort,
  RuntimeConfigPort,
  SessionRepositoryPort,
  UpdaterPort,
  WindowPort,
  WorkspaceFsPort,
} from "../ports";

export type BackendKind = "desktop-tauri" | "browser-preview";

export interface BackendPorts {
  piProcess: PiProcessPort;
  sessionRepository: SessionRepositoryPort;
  workspaceFs: WorkspaceFsPort;
  projectCatalog: ProjectCatalogPort;
  runtimeConfig: RuntimeConfigPort;
  piConfiguration: PiConfigurationPort;
  window: WindowPort;
  notification: NotificationPort;
  updater: UpdaterPort;
  assetUrl: AssetUrlPort;
  petWindow: PetWindowPort;
  externalNavigation: ExternalNavigationPort;
}

export type BackendPortName = keyof BackendPorts;

export class BackendContainerError extends Error {
  constructor(
    public readonly code: "unconfigured" | "already-configured" | "missing-port",
    message: string,
    public readonly backendKind: BackendKind | "unconfigured",
    public readonly portName?: BackendPortName
  ) {
    super(message);
    this.name = "BackendContainerError";
  }
}

interface ConfiguredBackend {
  kind: BackendKind;
  ports: Readonly<BackendPorts>;
}

let configured: ConfiguredBackend | null = null;

function configureBackend(kind: BackendKind, ports: BackendPorts): void {
  if (configured) {
    throw new BackendContainerError(
      "already-configured",
      `Backend container is already configured for ${configured.kind}.`,
      configured.kind
    );
  }
  configured = { kind, ports: Object.freeze({ ...ports }) };
}

export function configureDesktopBackend(ports: BackendPorts): void {
  configureBackend("desktop-tauri", ports);
}

export function configureBrowserBackend(ports: BackendPorts): void {
  configureBackend("browser-preview", ports);
}

export function getBackendKind(): BackendKind | "unconfigured" {
  return configured?.kind ?? "unconfigured";
}

export function getPort<Name extends BackendPortName>(name: Name): BackendPorts[Name] {
  if (!configured) {
    throw new BackendContainerError(
      "unconfigured",
      `Backend port "${name}" was requested before backend configuration.`,
      "unconfigured",
      name
    );
  }
  const port = configured.ports[name];
  if (!port) {
    throw new BackendContainerError(
      "missing-port",
      `Backend port "${name}" is not available for ${configured.kind}.`,
      configured.kind,
      name
    );
  }
  return port;
}

export function resetBackendContainerForTests(): void {
  configured = null;
}
