import type {
  LauncherCapabilities,
  LauncherInstallResult,
  RemotePiProfileInput,
  RemotePiProfile,
  RemoteReadinessCheck,
  RemoteReadinessReport,
} from "../ports/execution-target";
import type { RemotePiProfilePort } from "../ports/remote-profiles";

const DEFAULT_LAUNCHER_PATH = "/usr/local/bin/pi-desktop-launcher";

export function createMockRemotePiProfilePort(): RemotePiProfilePort {
  const profiles: RemotePiProfile[] = [];
  const installed = new Set<string>();

  function nextProfileId(): string {
    const base = `remote-${Date.now()}`;
    let candidate = base;
    let suffix = 2;
    while (profiles.some((profile) => profile.id === candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  /**
   * Browser preview has no SSH. The mock reproduces the report *shape* and the
   * cascade rule — a failed row leaves later rows unobserved — so the checklist
   * UI can be exercised without a host.
   */
  function report(
    profileId: string | undefined,
    host: string,
    remoteCwd: string | null | undefined,
    launcherPath: string,
  ): RemoteReadinessReport {
    // Mirrors the native command: a workspace is only checked when one is known, so a
    // profile with no browse directory still gets a full host verdict.
    const browseDirectory = remoteCwd?.trim() || "";
    const checks: RemoteReadinessCheck[] = [];
    const skip = (...ids: RemoteReadinessCheck["id"][]) => {
      for (const id of ids) checks.push({ id, status: "skipped" });
    };

    if (!host) {
      checks.push({ id: "ssh", status: "failed", errorCode: "ssh_host_unknown", error: "No SSH host alias" });
      skip("launcher", "node", "workspace", "pi", "piAuth");
      return { ok: false, profileId, host, remoteCwd: browseDirectory, launcherPath, checks };
    }
    checks.push({ id: "ssh", status: "ok", detail: host });

    if (!installed.has(`${host}:${launcherPath}`)) {
      checks.push({
        id: "launcher",
        status: "failed",
        errorCode: "launcher_missing",
        error: `No launcher at ${launcherPath}`,
      });
      skip("node", "workspace", "pi", "piAuth");
      return { ok: false, profileId, host, remoteCwd: browseDirectory, launcherPath, checks };
    }
    checks.push({ id: "launcher", status: "ok", detail: launcherPath });
    checks.push({ id: "node", status: "ok", detail: "v20.0.0" });

    if (browseDirectory.length === 0) {
      // No browse directory configured is not a failure: the host is still fully
      // checkable, and the workspace is validated when a project is picked.
      skip("workspace");
    } else if (!browseDirectory.startsWith("/")) {
      checks.push({
        id: "workspace",
        status: "failed",
        errorCode: "workspace_missing",
        error: "Remote workspace must be an absolute POSIX path",
      });
      skip("pi", "piAuth");
      return { ok: false, profileId, host, remoteCwd: browseDirectory, launcherPath, checks };
    } else {
      checks.push({ id: "workspace", status: "ok", detail: browseDirectory });
    }
    checks.push({ id: "pi", status: "ok", detail: "pi 0.0.0-mock" });
    checks.push({ id: "piAuth", status: "ok" });
    return {
      ok: true,
      profileId,
      host,
      remoteCwd: browseDirectory,
      launcherPath,
      piVersion: "pi 0.0.0-mock",
      home: "/home/preview",
      checks,
    };
  }

  return {
    list: async () => profiles.map((profile) => ({ ...profile })),
    save: async (input: RemotePiProfileInput) => {
      const existing = input.id ? profiles.find((profile) => profile.id === input.id) : undefined;
      if (input.id && !existing) throw new Error(`Remote profile \`${input.id}\` was not found`);
      const profile: RemotePiProfile = {
        id: existing?.id ?? input.id ?? nextProfileId(),
        revision: (existing?.revision ?? 0) + 1,
        name: input.name.trim(),
        sshHost: input.sshHost.trim(),
        remoteCwd: input.remoteCwd?.trim() || null,
        piExecutable: input.piExecutable?.trim() || null,
        launcherPath: input.launcherPath?.trim() || DEFAULT_LAUNCHER_PATH,
        launcherProtocolVersion: input.launcherProtocolVersion ?? 1,
        // Omitted keeps an existing profile's lifecycle, matching the native command.
        lifecycle: input.lifecycle ?? existing?.lifecycle ?? "attached",
      };
      const index = existing ? profiles.indexOf(existing) : -1;
      if (index >= 0) profiles[index] = profile;
      else profiles.push(profile);
      return { ...profile };
    },
    delete: async (id) => {
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index < 0) throw new Error(`Remote profile \`${id}\` was not found`);
      profiles.splice(index, 1);
    },
    preflight: async (id) => {
      const profile = profiles.find((candidate) => candidate.id === id);
      if (!profile) throw new Error(`Remote profile \`${id}\` was not found`);
      return report(profile.id, profile.sshHost, profile.remoteCwd, profile.launcherPath);
    },
    checkDraft: async (input) =>
      report(
        input.id,
        input.sshHost.trim(),
        input.remoteCwd?.trim() ?? null,
        input.launcherPath?.trim() || DEFAULT_LAUNCHER_PATH,
      ),
    installLauncher: async (host, launcherPath): Promise<LauncherInstallResult> => {
      if (!host.trim()) throw new Error("An SSH host alias is required");
      const resolved = launcherPath?.trim() || "/home/preview/.local/bin/pi-desktop-launcher";
      installed.add(`${host.trim()}:${resolved}`);
      return { launcherPath: resolved, host: host.trim() };
    },
    capabilities: async (id): Promise<LauncherCapabilities> => {
      const profile = profiles.find((candidate) => candidate.id === id);
      if (!profile) throw new Error(`Remote profile \`${id}\` was not found`);
      // The preview reports a current launcher: it models a working host, and a
      // simulated old launcher would only mislead anyone testing the UI here.
      return {
        host: profile.sshHost,
        launcherPath: profile.launcherPath,
        launcherProtocolVersion: 1,
        capabilities: [
          "attach-v1",
          "capabilities-v1",
          "detached-tasks-v1",
          "preflight-v1",
          "provider-sync-v1",
          "run-v1",
          "workspace-v1",
          "workspace-writes-v1",
        ],
        supportsCapabilityQuery: true,
        errorCode: null,
        error: null,
      };
    },
    // The preview has no SSH transport, so a detached task cannot be started here. It
    // answers with a stable handle rather than throwing, so the UI paths that depend on a
    // completed binding stay exercisable — but `state: "exited"` keeps it honest about
    // there being nothing to attach to.
    ensureTask: async (request) => ({
      remoteTaskId: request.remoteTaskId ?? "t-preview0000",
      state: "exited" as const,
      pid: null,
      supervisorPid: null,
      startedAt: null,
      previousTaskId: null,
      started: false,
      baseSequence: null,
      nextSequence: null,
    }),
    // No SSH transport in preview, so a task can only ever be reported gone. Honest
    // rather than convenient: a fabricated `running` would make the UI show a live
    // remote task that nothing could stop.
    taskStatus: async (_profileId: string, remoteTaskId: string) => ({
      remoteTaskId,
      state: "exited" as const,
      stale: false,
      exists: false,
      pid: null,
      piAlive: false,
      exitCode: null,
      stopRequestedAt: null,
      stopConfirmedAt: null,
      baseSequence: null,
      nextSequence: null,
    }),
    stopTask: async (_profileId: string, remoteTaskId: string) => ({
      remoteTaskId,
      state: "exited" as const,
      stale: false,
      exists: false,
      pid: null,
      piAlive: false,
      exitCode: null,
      stopRequestedAt: null,
      stopConfirmedAt: null,
      baseSequence: null,
      nextSequence: null,
    }),
    reapTasks: async () => ({ ok: true, repaired: 0, orphansKilled: 0, removed: 0 }),
    sshConfigHosts: async () => [],
  };
}
