import type { ExecutionBinding } from "./execution-target";

export type PiManagementScope = "global" | "project";
export type PiManagementCapability =
  | "pi-packages-read-v1"
  | "pi-packages-mutate-v1"
  | "pi-skills-read-v1"
  | "pi-skills-mutate-v1";

export interface PiManagementAvailability {
  capabilities: PiManagementCapability[];
  launcherOutdated: boolean;
  errorCode?: string | null;
  error?: string | null;
}

export interface PiManagementScopeFile {
  path: string;
  exists: boolean;
  content: string;
}

export interface ManagedSkillDto {
  name: string;
  description: string;
  origin: "global" | "project" | "path";
  /** Opaque to remote callers. Pass it back only to readSkillSource/mutateSkill. */
  sourceRef: string;
}

export interface PiManagementSnapshot {
  targetKey: string;
  stateToken: string;
  globalSettings: PiManagementScopeFile;
  projectSettings: PiManagementScopeFile;
  packageLocks: Record<PiManagementScope, string | null>;
  skills: ManagedSkillDto[];
  unscannableSkills: string[];
  skillLocks: Record<string, string>;
}

export type PackageMutationRequest =
  | { operation: "install"; scope: PiManagementScope; source: string; expectedState: string }
  | { operation: "remove"; scope: PiManagementScope; source: string; expectedState: string }
  | { operation: "update"; source: string; expectedState: string }
  | { operation: "updateAll"; expectedState: string };

export type SkillMutationRequest =
  | {
      operation: "install";
      scope: PiManagementScope;
      source: string;
      skills: string[];
      expectedState: string;
    }
  | { operation: "remove"; scope: PiManagementScope; name: string; expectedState: string }
  | { operation: "updateAll"; scope: PiManagementScope; expectedState: string }
  | {
      operation: "move";
      from: PiManagementScope;
      to: PiManagementScope;
      name: string;
      source: string;
      expectedState: string;
    };

export interface PiManagementMutationResult {
  snapshot: PiManagementSnapshot;
  code: number;
  stdout: string;
  stderr: string;
  halfDone?: boolean;
}

export interface PiManagementPort {
  availability(): Promise<PiManagementAvailability>;
  inspect(): Promise<PiManagementSnapshot>;
  readSkillSource(sourceRef: string): Promise<string>;
  browseSkillSource(source: string): Promise<{ name: string; description: string }[]>;
  mutatePackage(request: PackageMutationRequest): Promise<PiManagementMutationResult>;
  mutateSkill(request: SkillMutationRequest): Promise<PiManagementMutationResult>;
}

export type PiManagementPortFactory = (
  binding?: ExecutionBinding,
  projectRoot?: string | null,
  ) => PiManagementPort;

export function piManagementTargetKey(
  binding?: ExecutionBinding,
  projectRoot?: string | null,
 ): string {
  if (!binding || binding.kind === "local") return `local:${projectRoot ?? ""}`;
  return `ssh:${binding.profileId}@${binding.profileRevision}:${binding.remoteCwd}`;
}

export function piManagementScopeKey(
  binding: ExecutionBinding | undefined,
  scope: PiManagementScope,
  projectRoot?: string | null,
 ): string {
  return `${piManagementTargetKey(binding, projectRoot)}:${scope}`;
}
