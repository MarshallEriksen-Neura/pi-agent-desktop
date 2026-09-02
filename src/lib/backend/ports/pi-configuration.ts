import type { CustomModelDef, ModelsJson, ProviderConfig } from "../../pi/models";
import type { PackageEntry, PiSettings, SettingsScope } from "../../pi/settings";
import type { PiCliUpdateInfo } from "../../pi/cli-update";

export interface SettingsScopeFileDto {
  path: string;
  exists: boolean;
  content: string;
}

export interface CliResultDto {
  code: number;
  stdout: string;
  stderr: string;
}

export interface McpAdapterStatusDto {
  installed: boolean;
  otherConfigPaths: string[];
}

export interface McpDiscoverySourceDto {
  id: string;
  label: string;
  path: string;
  scope: SettingsScope;
  format: "json" | "toml";
  supported: boolean;
  content: string;
  reason: string | null;
}

export interface PiSkillDirectoryEntryDto {
  name: string;
  path: string;
  isDir: boolean;
}

export interface SkillCatalogHitDto {
  id: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
}

export interface PiConfigurationPort {
  readSettings(scope: SettingsScope | "models", root?: string | null): Promise<SettingsScopeFileDto>;
  writeSettings(scope: SettingsScope | "models", content: string, root?: string | null): Promise<void>;
  readMcpConfig(scope: SettingsScope, root?: string | null): Promise<SettingsScopeFileDto>;
  writeMcpConfig(scope: SettingsScope, content: string, root?: string | null): Promise<void>;
  openMcpConfigDirectory(scope: SettingsScope, root?: string | null): Promise<void>;
  checkMcpAdapter(root?: string | null): Promise<McpAdapterStatusDto>;
  discoverMcpSources(root?: string | null): Promise<McpDiscoverySourceDto[]>;
  fetchModels(config: ProviderConfig): Promise<string[]>;
  runPiCli(args: string[], cwd?: string | null): Promise<CliResultDto>;
  /** `npx skills …` — skill install/remove/update, see src/lib/pi/skills-install.ts */
  runSkillsCli(args: string[], cwd?: string | null): Promise<CliResultDto>;
  /**
   * skills.sh catalogue search. Native rather than `fetch` because the endpoint
   * sends no CORS headers, so the webview is not allowed to read the response.
   */
  searchSkills(query: string, limit: number): Promise<SkillCatalogHitDto[]>;
  checkPiCliUpdate(): Promise<PiCliUpdateInfo>;
  readSkillFile(path: string): Promise<string>;
  listSkillDirectory(path: string): Promise<PiSkillDirectoryEntryDto[]>;
  /**
   * Raw `package-lock.json` of a settings scope's npm tree — the only record of
   * which version of each plugin package is actually installed. `null` when the
   * scope has no npm tree yet, which is the normal state for a project that
   * declares nothing, not an error.
   */
  readPackageLock(path: string): Promise<string | null>;
}

export type PiSettingsDto = PiSettings;
export type PiModelsDto = ModelsJson;
export type PiPackageEntryDto = PackageEntry;
export type PiCustomModelDto = CustomModelDef;
