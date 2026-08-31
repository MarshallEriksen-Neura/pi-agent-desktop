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
    };

export interface RemotePiProfile {
  id: string;
  revision: number;
  name: string;
  sshHost: string;
  remoteCwd: string;
  piExecutable?: string | null;
  launcherPath: string;
  launcherProtocolVersion: number;
  lifecycle: "attached";
}

export interface RemotePiProfileInput {
  id?: string;
  name: string;
  sshHost: string;
  remoteCwd: string;
  piExecutable?: string | null;
  launcherPath?: string;
  launcherProtocolVersion?: number;
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
  remoteCwd: string;
  launcherPath: string;
  piVersion?: string;
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
  | "capabilities-v1";

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
