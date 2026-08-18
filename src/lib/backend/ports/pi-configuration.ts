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
  checkPiCliUpdate(): Promise<PiCliUpdateInfo>;
  readSkillFile(path: string): Promise<string>;
  listSkillDirectory(path: string): Promise<PiSkillDirectoryEntryDto[]>;
}

export type PiSettingsDto = PiSettings;
export type PiModelsDto = ModelsJson;
export type PiPackageEntryDto = PackageEntry;
export type PiCustomModelDto = CustomModelDef;
