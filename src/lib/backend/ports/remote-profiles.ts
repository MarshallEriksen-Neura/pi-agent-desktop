import type {
  LauncherCapabilities,
  LauncherInstallResult,
  RemotePiProfile,
  RemotePiProfileInput,
  RemoteReadinessReport,
} from "./execution-target";

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
  /** `Host` aliases from the local `~/.ssh/config`; empty when there is none. */
  sshConfigHosts(): Promise<string[]>;
}
