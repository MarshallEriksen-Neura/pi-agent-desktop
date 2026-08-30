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
