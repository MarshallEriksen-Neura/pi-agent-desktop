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
    remoteCwd: string,
    launcherPath: string,
  ): RemoteReadinessReport {
    const checks: RemoteReadinessCheck[] = [];
    const skip = (...ids: RemoteReadinessCheck["id"][]) => {
      for (const id of ids) checks.push({ id, status: "skipped" });
    };

    if (!host) {
      checks.push({ id: "ssh", status: "failed", errorCode: "ssh_host_unknown", error: "No SSH host alias" });
      skip("launcher", "node", "workspace", "pi", "piAuth");
      return { ok: false, profileId, host, remoteCwd, launcherPath, checks };
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
      return { ok: false, profileId, host, remoteCwd, launcherPath, checks };
    }
    checks.push({ id: "launcher", status: "ok", detail: launcherPath });
    checks.push({ id: "node", status: "ok", detail: "v20.0.0" });

    if (!remoteCwd.startsWith("/")) {
      checks.push({
        id: "workspace",
        status: "failed",
        errorCode: "workspace_missing",
        error: "Remote workspace must be an absolute POSIX path",
      });
      skip("pi", "piAuth");
      return { ok: false, profileId, host, remoteCwd, launcherPath, checks };
    }
    checks.push({ id: "workspace", status: "ok", detail: remoteCwd });
    checks.push({ id: "pi", status: "ok", detail: "pi 0.0.0-mock" });
    checks.push({ id: "piAuth", status: "ok" });
    return { ok: true, profileId, host, remoteCwd, launcherPath, piVersion: "pi 0.0.0-mock", checks };
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
        remoteCwd: input.remoteCwd.trim(),
        piExecutable: input.piExecutable?.trim() || null,
        launcherPath: input.launcherPath?.trim() || DEFAULT_LAUNCHER_PATH,
        launcherProtocolVersion: input.launcherProtocolVersion ?? 1,
        lifecycle: "attached",
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
        input.remoteCwd.trim(),
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
        capabilities: ["capabilities-v1", "preflight-v1", "provider-sync-v1", "run-v1"],
        supportsCapabilityQuery: true,
        errorCode: null,
        error: null,
      };
    },
    sshConfigHosts: async () => [],
  };
}
