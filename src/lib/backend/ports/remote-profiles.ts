import type {
  LauncherCapabilities,
  LauncherInstallResult,
  RemotePiProfile,
  RemotePiProfileInput,
  RemoteReadinessReport,
} from "./execution-target";

export interface RemoteTaskEnsureRequest {
  profileId: string;
  /** Omit for a fresh task; supply to reattach to, or replace, an existing one. */
  remoteTaskId?: string;
  /** Where pi runs — a per-conversation choice, not a profile setting. */
  remoteCwd: string;
  resumePath?: string;
}

/**
 * What `--status` reports, as the desktop sees it.
 *
 * These are **process** states. The four *connection* states the UI shows are derived
 * from these plus what the desktop knows about its own channel — see
 * `src/lib/pi/remote-connection-state.ts`.
 */
export interface RemoteTaskReport {
  remoteTaskId: string;
  state: "starting" | "running" | "stopping" | "exited";
  /** `true` when the death was never witnessed — the supervisor was gone when asked. */
  stale: boolean;
  /** `false` when the task directory is gone: a spent id, not a failure. */
  exists: boolean;
  pid?: number | null;
  piAlive: boolean;
  exitCode?: number | null;
  stopRequestedAt?: number | null;
  stopConfirmedAt?: number | null;
  baseSequence?: number | null;
  nextSequence?: number | null;
}

export interface RemoteTaskHandle {
  /** The id to put on the binding and persist with the conversation. */
  remoteTaskId: string;
  state: "starting" | "running" | "stopping" | "exited";
  pid?: number | null;
  supervisorPid?: number | null;
  startedAt?: number | null;
  /**
   * Set when a new id had to be minted because the previous task was dead.
   *
   * One `remoteTaskId` is one remote pi process for its whole life, so a caller holding a
   * cursor into the old journal must treat its transcript as ended, not continued.
   */
  previousTaskId?: string | null;
  /** `true` when this call started the task rather than finding it alive. */
  started: boolean;
  /** Oldest sequence still retained, so a stale cursor is detectable before attaching. */
  baseSequence?: number | null;
  nextSequence?: number | null;
}

export interface RemotePiProfilePort {
  list(): Promise<RemotePiProfile[]>;
  save(profile: RemotePiProfileInput): Promise<RemotePiProfile>;
  delete(id: string): Promise<void>;
  /** Checks a stored profile — used before switching a conversation over. */
  preflight(id: string): Promise<RemoteReadinessReport>;
  /**
   * Checks an unsaved draft, so the form can validate before it persists
   * anything. Rejects on field-shape errors; anything the remote host reports
   * comes back in the checklist.
   */
  checkDraft(profile: RemotePiProfileInput): Promise<RemoteReadinessReport>;
  /**
   * Copies the launcher to the host and returns the absolute path it landed on.
   * Omit `launcherPath` to resolve `$HOME/.local/bin/pi-desktop-launcher`, which
   * needs no sudo.
   */
  installLauncher(host: string, launcherPath?: string): Promise<LauncherInstallResult>;
  /**
   * Asks a stored profile's launcher what it supports. Resolves even when the
   * launcher is too old to answer — see `LauncherCapabilities`.
   */
  capabilities(id: string): Promise<LauncherCapabilities>;
  /**
   * Mint or reattach a detached task, so the process port only has to attach.
   *
   * Separate from starting the process because this is the part that talks to the host —
   * two bounded SSH round trips — and `pi_start` is synchronous.
   */
  ensureTask(request: RemoteTaskEnsureRequest): Promise<RemoteTaskHandle>;
  /**
   * What the host says a task is doing.
   *
   * The only way out of `lost`: a partitioned pi stays alive for ~2h after the local
   * transport gives up at 24.2s, so the desktop cannot infer this and must not guess.
   */
  taskStatus(profileId: string, remoteTaskId: string): Promise<RemoteTaskReport>;
  /**
   * Stop the remote task itself — not the channel to it.
   *
   * Separate from closing the attach, because those are different intents: "I am done
   * looking at this" versus "stop working". Conflating them would make closing a window
   * kill remote work, which is the opposite of why detached mode exists.
   */
  stopTask(profileId: string, remoteTaskId: string): Promise<RemoteTaskReport>;
  /** Opportunistic housekeeping — reap orphans and expired task directories. */
  reapTasks(profileId: string): Promise<unknown>;
  /** `Host` aliases from the local `~/.ssh/config`; empty when there is none. */
  sshConfigHosts(): Promise<string[]>;
}
