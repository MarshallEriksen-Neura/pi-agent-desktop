import type { LauncherCapabilities, ExecutionBinding } from "../ports/execution-target";
import type {
  PackageMutationRequest,
  PiManagementCapability,
  PiManagementMutationResult,
  PiManagementPort,
  PiManagementSnapshot,
  SkillMutationRequest,
} from "../ports/pi-management";
import { desktopInvoke } from "./invoke";

const MANAGEMENT_CAPABILITIES: PiManagementCapability[] = [
  "pi-packages-read-v1",
  "pi-packages-mutate-v1",
  "pi-skills-read-v1",
  "pi-skills-mutate-v1",
];

export class RemotePiManagementError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `Remote PI management ${code}: ${detail}` : `Remote PI management ${code}`);
    this.name = "RemotePiManagementError";
  }
}

export class RemotePiManagementUnavailableError extends RemotePiManagementError {
  constructor(detail?: string) {
    super("launcher-outdated", detail ?? "The remote launcher must be upgraded");
    this.name = "RemotePiManagementUnavailableError";
  }
}

interface ManagementReply<T> {
  ok: boolean;
  operation?: string;
  result?: T;
  errorCode?: string;
  detail?: string;
}

function assertResult<T>(reply: ManagementReply<T>): T {
  if (!reply || reply.ok !== true || reply.result === undefined) {
    throw new RemotePiManagementError(reply?.errorCode ?? "invalid-reply", reply?.detail);
  }
  return reply.result;
}

export interface RemotePiManagementDependencies {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const DEFAULT_DEPENDENCIES: RemotePiManagementDependencies = {
  invoke: (command, args) => desktopInvoke(command, args),
};

export function createDesktopRemotePiManagement(
  binding: Extract<ExecutionBinding, { kind: "ssh" }>,
  dependencies: RemotePiManagementDependencies = DEFAULT_DEPENDENCIES,
): PiManagementPort {
  const targetKey = `ssh:${binding.profileId}@${binding.profileRevision}:${binding.remoteCwd}`;
  const normalizeSnapshot = (snapshot: PiManagementSnapshot): PiManagementSnapshot => ({
    ...snapshot,
    targetKey,
  });
  const normalizeMutationResult = (result: PiManagementMutationResult): PiManagementMutationResult => ({
    ...result,
    snapshot: normalizeSnapshot(result.snapshot),
  });
  const request = async <T>(body: Record<string, unknown>): Promise<T> => {
    try {
      const reply = await dependencies.invoke<ManagementReply<T>>("remote_pi_management_request", {
        id: binding.profileId,
        profileRevision: binding.profileRevision,
        remoteCwd: binding.remoteCwd,
        request: body,
      });
      return assertResult(reply);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.startsWith("launcher-outdated:") || message.includes("invalid launcher mode")) {
        throw new RemotePiManagementUnavailableError(message);
      }
      throw cause;
    }
  };

  return {
    availability: async () => {
      try {
        const probe = await dependencies.invoke<LauncherCapabilities>("remote_profile_capabilities", {
          id: binding.profileId,
        });
        const capabilities = MANAGEMENT_CAPABILITIES.filter((capability) =>
          probe.supportsCapabilityQuery && probe.capabilities.includes(capability),
        );
        return {
          capabilities,
          launcherOutdated: capabilities.length === 0 && !probe.errorCode,
          errorCode: probe.errorCode,
          error: probe.error,
        };
      } catch (cause) {
        return {
          capabilities: [],
          launcherOutdated: false,
          errorCode: "capability-probe-failed",
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    inspect: async () => normalizeSnapshot(
      await request<PiManagementSnapshot>({ operation: "inspect" }),
    ),
    readSkillSource: (sourceRef) =>
      request<string>({ operation: "readSkillSource", sourceRef }),
    browseSkillSource: (source) =>
      request<{ name: string; description: string }[]>({ operation: "browseSkillSource", source }),
    mutatePackage: async (mutation: PackageMutationRequest) => normalizeMutationResult(
      await request<PiManagementMutationResult>({ operation: "mutatePackage", mutation }),
    ),
    mutateSkill: async (mutation: SkillMutationRequest) => normalizeMutationResult(
      await request<PiManagementMutationResult>({ operation: "mutateSkill", mutation }),
    ),
  };
}
