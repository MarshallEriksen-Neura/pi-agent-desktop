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

export interface PiSkillDirectoryEntryDto {
  name: string;
  path: string;
  isDir: boolean;
}

export interface PiConfigurationPort {
  readSettings(scope: SettingsScope | "models", root?: string | null): Promise<SettingsScopeFileDto>;
  writeSettings(scope: SettingsScope | "models", content: string, root?: string | null): Promise<void>;
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
