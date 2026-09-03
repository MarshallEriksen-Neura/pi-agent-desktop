import type {
  ManagedSkillDto,
  PackageMutationRequest,
  PiConfigurationPort,
  PiManagementMutationResult,
  PiManagementPort,
  PiManagementPortFactory,
  PiManagementScope,
  PiManagementSnapshot,
  SkillMutationRequest,
} from "../ports";
import type { ExecutionBinding } from "../ports/execution-target";
import { piManagementTargetKey } from "../ports/pi-management";
import { normalizePackageSource, packageInstallArgs } from "../../pi/package-install";
import { parseSkillList } from "../../pi/skill-list-parser";

const ALL_CAPABILITIES = [
  "pi-packages-read-v1",
  "pi-packages-mutate-v1",
  "pi-skills-read-v1",
  "pi-skills-mutate-v1",
] as const;
const CONTROL = /[\u0000-\u001f\u007f]/;
const GLOB = /[*?\[\]{}]/;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function parent(path: string): string {
  const normalized = normalize(path);
  return normalized.slice(0, normalized.lastIndexOf("/"));
}

function tokenFor(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `local-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function parseSkillMd(content: string, fallback: string): { name: string; description: string } {
  let name = fallback;
  let description = "";
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  for (const line of frontmatter?.[1]?.split(/\r?\n/) ?? []) {
    const field = line.match(/^(name|description):\s*(.*)$/);
    if (!field) continue;
    const value = (field[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (field[1] === "name" && value) name = value;
    if (field[1] === "description") description = value;
  }
  return { name, description };
}

async function optionalRead(port: PiConfigurationPort, path: string): Promise<string | null> {
  if (!path) return null;
  try {
    return await port.readSkillFile(path);
  } catch {
    return null;
  }
}

async function scanDirectory(
  port: PiConfigurationPort,
  directory: string,
  origin: ManagedSkillDto["origin"],
): Promise<ManagedSkillDto[]> {
  const ownFile = `${normalize(directory)}/SKILL.md`;
  const own = await optionalRead(port, ownFile);
  if (own !== null) {
    return [{ ...parseSkillMd(own, normalize(directory).split("/").pop() || directory), origin, sourceRef: ownFile }];
  }
  try {
    const entries = await port.listSkillDirectory(directory);
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDir)
        .slice(0, 2048)
        .map(async (entry) => {
          const file = `${normalize(entry.path)}/SKILL.md`;
          const content = await optionalRead(port, file);
          return content === null
            ? null
            : { ...parseSkillMd(content, entry.name), origin, sourceRef: file };
        }),
    );
    return skills.filter((skill): skill is ManagedSkillDto => skill !== null);
  } catch {
    return [];
  }
}

function configuredSkillDirectories(
  content: string,
  settingsRoot: string,
  home: string,
): { directories: string[]; unscannable: string[] } {
  let values: unknown[] = [];
  try {
    const parsed = JSON.parse(content) as { skills?: unknown[] };
    values = Array.isArray(parsed.skills) ? parsed.skills : [];
  } catch {
    return { directories: [], unscannable: [] };
  }
  const directories: string[] = [];
  const unscannable: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    if (value.startsWith("!") || GLOB.test(value)) {
      unscannable.push(value);
      continue;
    }
    const path = value.startsWith("~/")
      ? `${home}/${value.slice(2)}`
      : /^(?:\/|[A-Za-z]:[\\/])/.test(value)
        ? value
        : `${settingsRoot}/${value}`;
    directories.push(normalize(path));
  }
  return { directories, unscannable };
}

function safeSkillValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || CONTROL.test(trimmed) || trimmed.length > 2048) {
    throw new Error(`Invalid ${label}`);
  }
  return trimmed;
}

function skillsScopeArgs(scope: PiManagementScope): string[] {
  return scope === "global" ? ["-g"] : [];
}

function createLocalPort(
  configuration: PiConfigurationPort,
  binding: ExecutionBinding | undefined,
  projectRoot: string | null,
): PiManagementPort {
  const targetKey = piManagementTargetKey(binding, projectRoot);

  const inspect = async (): Promise<PiManagementSnapshot> => {
    const [globalSettings, projectSettings] = await Promise.all([
      configuration.readSettings("global", projectRoot),
      configuration.readSettings("project", projectRoot),
    ]);
    const globalRoot = parent(globalSettings.path);
    const projectSettingsRoot = projectSettings.path ? parent(projectSettings.path) : "";
    const home = globalRoot.replace(/\/\.pi\/agent$/, "");
    const globalCustom = configuredSkillDirectories(globalSettings.content, globalRoot, home);
    const projectCustom = configuredSkillDirectories(projectSettings.content, projectSettingsRoot, home);
    const roots: { directory: string; origin: ManagedSkillDto["origin"] }[] = [
      { directory: `${globalRoot}/skills`, origin: "global" },
      ...(projectSettingsRoot ? [{ directory: `${projectSettingsRoot}/skills`, origin: "project" as const }] : []),
      ...globalCustom.directories.map((directory) => ({ directory, origin: "path" as const })),
      ...projectCustom.directories.map((directory) => ({ directory, origin: "path" as const })),
    ];
    const skills = (await Promise.all(roots.map(({ directory, origin }) => scanDirectory(configuration, directory, origin))))
      .flat()
      .slice(0, 2048);
    const globalPackageLockPath = `${globalRoot}/npm/package-lock.json`;
    const projectPackageLockPath = projectSettingsRoot ? `${projectSettingsRoot}/npm/package-lock.json` : "";
    const [globalPackageLock, projectPackageLock, globalSkillLock, projectSkillLock] = await Promise.all([
      configuration.readPackageLock(globalPackageLockPath),
      projectPackageLockPath ? configuration.readPackageLock(projectPackageLockPath) : Promise.resolve(null),
      optionalRead(configuration, `${home}/.agents/.skill-lock.json`),
      projectRoot ? optionalRead(configuration, `${normalize(projectRoot)}/skills-lock.json`) : Promise.resolve(null),
    ]);
    const skillLocks: Record<string, string> = {};
    for (const content of [globalSkillLock, projectSkillLock]) {
      try {
        const parsed = JSON.parse(content ?? "") as { skills?: Record<string, { source?: string; sourceUrl?: string }> };
        for (const [name, item] of Object.entries(parsed.skills ?? {})) {
          const source = item.source || item.sourceUrl;
          if (source) skillLocks[name] = source;
        }
      } catch {
        // A missing or malformed optional lock is equivalent to no known source.
      }
    }
    const stable = {
      globalSettings,
      projectSettings,
      globalPackageLock,
      projectPackageLock,
      skills,
      skillLocks,
    };
    return {
      targetKey,
      stateToken: tokenFor(stable),
      globalSettings,
      projectSettings,
      packageLocks: { global: globalPackageLock, project: projectPackageLock },
      skills,
      unscannableSkills: [...globalCustom.unscannable, ...projectCustom.unscannable],
      skillLocks,
    };
  };

  const requireState = async (expectedState: string): Promise<void> => {
    if ((await inspect()).stateToken !== expectedState) {
      throw new Error("PI management state changed; refresh and try again");
    }
  };

  const complete = async (result: { code: number; stdout: string; stderr: string }, halfDone = false): Promise<PiManagementMutationResult> => ({
    ...result,
    snapshot: await inspect(),
    ...(halfDone ? { halfDone: true } : {}),
  });

  return {
    availability: async () => ({ capabilities: [...ALL_CAPABILITIES], launcherOutdated: false }),
    inspect,
    readSkillSource: async (sourceRef) => {
      if (!sourceRef.endsWith("/SKILL.md") && !sourceRef.endsWith("\\SKILL.md")) throw new Error("Invalid skill source reference");
      const content = await configuration.readSkillFile(sourceRef);
      if (content.length > 256 * 1024) throw new Error("SKILL.md exceeds the 256 KiB limit");
      return content;
    },
    browseSkillSource: async (source) => {
      const safe = safeSkillValue(source, "skill source");
      const result = await configuration.runSkillsCli(["add", safe, "--list"], projectRoot);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "skills list failed");
      return parseSkillList(result.stdout);
    },
    mutatePackage: async (request: PackageMutationRequest) => {
      await requireState(request.expectedState);
      let args: string[];
      if (request.operation === "install") {
        const source = normalizePackageSource(request.source);
        if (!source) throw new Error("Invalid package source");
        args = packageInstallArgs(source, request.scope);
      } else if (request.operation === "remove") {
        const source = safeSkillValue(request.source, "package source");
        args = request.scope === "project" ? ["remove", source, "-l"] : ["remove", source];
      } else if (request.operation === "update") {
        args = ["update", safeSkillValue(request.source, "package source")];
      } else {
        args = ["update", "--extensions"];
      }
      return complete(await configuration.runPiCli([...args, "--approve"], projectRoot));
    },
    mutateSkill: async (request: SkillMutationRequest) => {
      await requireState(request.expectedState);
      if (request.operation === "install") {
        const source = safeSkillValue(request.source, "skill source");
        const names = request.skills.map((name) => safeSkillValue(name, "skill name"));
        return complete(await configuration.runSkillsCli([
          "add", source,
          ...names.flatMap((name) => ["--skill", name]),
          "--agent", "pi",
          ...skillsScopeArgs(request.scope),
          "--copy", "-y",
        ], projectRoot));
      }
      if (request.operation === "remove") {
        return complete(await configuration.runSkillsCli([
          "remove", "--skill", safeSkillValue(request.name, "skill name"),
          "--agent", "pi", ...skillsScopeArgs(request.scope), "-y",
        ], projectRoot));
      }
      if (request.operation === "updateAll") {
        return complete(await configuration.runSkillsCli([
          "update", request.scope === "global" ? "-g" : "-p", "-y",
        ], projectRoot));
      }
      const added = await configuration.runSkillsCli([
        "add", safeSkillValue(request.source, "skill source"),
        "--skill", safeSkillValue(request.name, "skill name"),
        "--agent", "pi", ...skillsScopeArgs(request.to), "--copy", "-y",
      ], projectRoot);
      if (added.code !== 0) return complete(added);
      const removed = await configuration.runSkillsCli([
        "remove", "--skill", safeSkillValue(request.name, "skill name"),
        "--agent", "pi", ...skillsScopeArgs(request.from), "-y",
      ], projectRoot);
      return complete(removed, removed.code !== 0);
    },
  };
}

export function createDesktopPiManagementFactory(
  configuration: PiConfigurationPort,
  createRemote: (binding: Extract<ExecutionBinding, { kind: "ssh" }>) => PiManagementPort,
): PiManagementPortFactory {
  return (binding, projectRoot = null) =>
    binding?.kind === "ssh"
      ? createRemote(binding)
      : createLocalPort(configuration, binding, projectRoot);
}
