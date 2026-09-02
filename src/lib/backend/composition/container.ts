import type {
  AssetUrlPort,
  ExternalNavigationPort,
  FileDropPort,
  NotificationPort,
  PetWindowPort,
  PiConfigurationPort,
  PiProcessPort,
  ProjectCatalogPort,
  ProviderAuthPort,
  RemoteControlPort,
  RemoteConversationsPort,
  RemotePiProfilePort,
  RemoteTerminalPort,
  RemoteProviderSyncPort,
  SessionRepositoryPort,
  UpdaterPort,
  WindowPort,
  WorkspaceFsPort,
} from "../ports";

export type BackendKind = "desktop-tauri" | "browser-preview";

export interface BackendPorts {
  piProcess: PiProcessPort;
  /** Factory for per-task pi-process ports — one process per conversation. */
  createPiProcess: PiProcessPortFactory;
  sessionRepository: SessionRepositoryPort;
  /**
   * The local filesystem. Kept as the default for callers with no execution
   * target in hand; anything that can run against a remote target must resolve
   * through `createWorkspaceFs` instead.
   */
  workspaceFs: WorkspaceFsPort;
  /**
   * Filesystem for one execution target.
   *
   * Paths stay bare strings because a port instance is already bound to a single
   * host — the host is carried by *which instance you hold*, exactly as
   * `createPiProcess` carries its target. That is also the safety property: an
   * SSH binding cannot resolve to the local implementation, so a remote path has
   * no route to the local filesystem bridge.
   */
  createWorkspaceFs: WorkspaceFsPortFactory;
  projectCatalog: ProjectCatalogPort;
  providerAuth: ProviderAuthPort;
  remoteControl: RemoteControlPort;
  remoteConversations: RemoteConversationsPort;
  remoteProfiles: RemotePiProfilePort;
  remoteTerminal: RemoteTerminalPort;
  remoteProviderSync: RemoteProviderSyncPort;
  piConfiguration: PiConfigurationPort;
  window: WindowPort;
  notification: NotificationPort;
  updater: UpdaterPort;
  assetUrl: AssetUrlPort;
  petWindow: PetWindowPort;
  externalNavigation: ExternalNavigationPort;
  /**
   * OS drag-and-drop over the window. Window-scoped by nature — the drop never
   * reaches the DOM, so element-level drop zones hit-test the reported position.
   */
  fileDrop: FileDropPort;
}

export type BackendPortName = keyof BackendPorts;

/** Creates an isolated pi-process port bound to a task and optional execution target. */
export type PiProcessPortFactory = (
  taskId?: string,
  executionBinding?: import("../ports/execution-target").ExecutionBinding,
  ) => PiProcessPort;

/**
 * Resolves the filesystem port for one execution target. Omitted ⇒ local.
 *
 * Takes a target id, not a full `ExecutionBinding`, unlike `createPiProcess`.
 * The difference is real rather than stylistic: launching pi genuinely needs the
 * whole binding (host alias, cwd, launcher version, revision to re-validate),
 * while choosing a filesystem needs only *which host*. Accepting a binding here
 * would force callers holding just a path to fabricate one, and a made-up
 * revision or cwd is exactly the kind of value a later implementation could act
 * on.
 */
export type WorkspaceFsPortFactory = (
  targetId?: import("../../workspace-target").WorkspaceTargetId,
) => WorkspaceFsPort;

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
