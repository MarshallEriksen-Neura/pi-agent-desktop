export type ExecutionBinding =
  | {
      kind: "local";
      targetId: "local";
    }
  | {
      kind: "ssh";
      profileId: string;
      profileRevision: number;
      hostAlias: string;
      remoteCwd: string;
      launcherProtocolVersion: number;
      /**
       * Which remote task this binding drives. Present exactly when the profile is
       * `detached`.
       *
       * Deliberately orthogonal to the process `generation`: generation is a local
       * per-spawn counter, and attaching to a task opens a new local ssh child — a
       * new generation against the *same* remote task. Conflating the two makes
       * replayed events get filtered out.
       */
      remoteTaskId?: string | null;
    };

export interface RemotePiProfile {
  id: string;
  revision: number;
  name: string;
  sshHost: string;
  /**
   * Where a folder browser opens on this host, **not** where pi runs.
   *
   * The workspace lives on `ExecutionBinding` because it is a per-conversation choice,
   * not host configuration — a profile describes a machine, and one machine holds many
   * projects. `null` falls back to the remote `$HOME` reported by preflight.
   */
  remoteCwd?: string | null;
  piExecutable?: string | null;
  launcherPath: string;
  launcherProtocolVersion: number;
  /**
   * `attached`: pi's lifetime is the SSH channel's — it dies with it.
   * `detached`: pi outlives the channel under the launcher's supervisor.
   * See docs/remote-agent-v2-supervisor-protocol.md.
   */
  lifecycle: "attached" | "detached";
}

export interface RemotePiProfileInput {
  id?: string;
  name: string;
  sshHost: string;
  /** Optional browse starting point — see `RemotePiProfile.remoteCwd`. */
  remoteCwd?: string | null;
  piExecutable?: string | null;
  launcherPath?: string;
  launcherProtocolVersion?: number;
  /** Omitted keeps an existing profile's lifecycle and defaults a new one to `attached`. */
  lifecycle?: "attached" | "detached";
}

/** Prerequisites the setup checklist reports on, in display order. */
export type RemoteReadinessCheckId =
  | "ssh"
  | "launcher"
  | "node"
  | "workspace"
  | "pi"
  | "piAuth";

export type RemoteReadinessStatus = "ok" | "failed" | "warning" | "skipped";

export interface RemoteReadinessCheck {
  id: RemoteReadinessCheckId;
  status: RemoteReadinessStatus;
  /** Already-human text: a version string, a resolved path. */
  detail?: string;
  errorCode?: string;
  error?: string;
}

/**
 * Per-prerequisite result of one preflight round trip. Each distinct failure
 * mode lands on its own row so the UI can point at the field that fixes it.
 */
export interface RemoteReadinessReport {
  ok: boolean;
  profileId?: string;
  host: string;
  /** The browse directory that was checked, or `""` when none was. */
  remoteCwd: string;
  launcherPath: string;
  piVersion?: string;
  /**
   * The remote `$HOME`, so a folder browser has somewhere to open.
   *
   * The desktop cannot expand `$HOME` locally and the launcher only accepts absolute
   * paths, so without this a first browse would have to start at `/`. Absent from a
   * launcher that predates it, and from any failed check.
   */
  home?: string | null;
  checks: RemoteReadinessCheck[];
}

export interface LauncherInstallResult {
  /** Absolute path the remote installer resolved and wrote to. */
  launcherPath: string;
  host: string;
}

/** Capability names this build knows how to ask for. */
export type LauncherCapability =
  | "run-v1"
  | "preflight-v1"
  | "provider-sync-v1"
  | "capabilities-v1"
  /** `--start-detached`, `--status`, `--stop`, `--send`, `--reap`, as one unit. */
  | "detached-tasks-v1"
  /** `--attach`: cursor replay and live tailing over a task's journal. */
  | "attach-v1"
  /** `--workspace` read half: list, read, stat. */
  | "workspace-v1"
  /**
   * `--workspace` write half: hash-checked write/create/mkdir/delete/rename.
   *
   * Separate from `workspace-v1` so a host whose launcher predates writes can still
   * offer browsing, with editing refused rather than attempted.
   */
  | "workspace-writes-v1";

/**
 * What a host's launcher reports it can do.
 *
 * A launcher older than the capability query answers any unknown mode with
 * `invalid launcher mode` and exit 64 — indistinguishable from a corrupt one. So
 * `supportsCapabilityQuery: false` with no `errorCode` is the normal, expected
 * answer for an old launcher, and callers must degrade rather than surface it as
 * a failure. Only `errorCode` means the user has something to fix.
 */
export interface LauncherCapabilities {
  host: string;
  launcherPath: string;
  /**
   * Payload-protocol version for run/preflight. Capabilities are versioned
   * independently — never infer a capability from this number.
   */
  launcherProtocolVersion: number;
  capabilities: string[];
  supportsCapabilityQuery: boolean;
  errorCode?: string | null;
  error?: string | null;
}

/** Whether a probe result grants `capability`. Absent query ⇒ V1 baseline only. */
export function hasLauncherCapability(
  probe: LauncherCapabilities | null | undefined,
  capability: LauncherCapability,
): boolean {
  if (!probe) return false;
  if (probe.supportsCapabilityQuery) return probe.capabilities.includes(capability);
  // A launcher that cannot answer the query still has the V1 surface, which
  // shipped before capabilities existed. Treating those as absent would break
  // every already-installed host.
  return capability === "run-v1" || capability === "preflight-v1";
}
