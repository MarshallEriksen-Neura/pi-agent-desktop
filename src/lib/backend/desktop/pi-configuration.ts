import type {
  CliResultDto,
  PiConfigurationPort,
  PiSkillDirectoryEntryDto,
  SettingsScopeFileDto,
  SkillCatalogHitDto,
  McpAdapterStatusDto,
  McpDiscoverySourceDto,
} from "../ports";
import type { ProviderConfig } from "../../pi/models";
import type { SettingsScope } from "../../pi/settings";
import type { PiCliUpdateInfo } from "../../pi/cli-update";
import { desktopInvoke } from "./invoke";

export const desktopPiConfigurationPort: PiConfigurationPort = {
  readSettings: (scope: SettingsScope, root?: string | null) =>
    desktopInvoke<SettingsScopeFileDto>("pi_settings_read", {
      scope,
      root: root ?? null,
    }),

  writeSettings: (scope: SettingsScope | "models", content: string, root?: string | null) =>
    desktopInvoke<void>("pi_settings_write", {
      scope,
      content,
      root: root ?? null,
    }),

  readMcpConfig: (scope: SettingsScope, root?: string | null) =>
    desktopInvoke<SettingsScopeFileDto>("mcp_config_read", {
      scope,
      root: root ?? null,
    }),

  writeMcpConfig: (scope: SettingsScope, content: string, root?: string | null) =>
    desktopInvoke<void>("mcp_config_write", {
      scope,
      content,
      root: root ?? null,
    }),

  openMcpConfigDirectory: (scope: SettingsScope, root?: string | null) =>
    desktopInvoke<void>("mcp_config_open_dir", {
      scope,
      root: root ?? null,
    }),

  checkMcpAdapter: (root?: string | null) =>
    desktopInvoke<McpAdapterStatusDto>("mcp_adapter_check", { root: root ?? null }),

  discoverMcpSources: (root?: string | null) =>
    desktopInvoke<McpDiscoverySourceDto[]>("mcp_config_discover", { root: root ?? null }),

  fetchModels: (config: ProviderConfig) =>
    desktopInvoke<string[]>("pi_fetch_models", {
      baseUrl: config.baseUrl,
      api: config.api,
      apiKey: config.apiKey ?? null,
    }),

  runPiCli: (args: string[], cwd?: string | null) =>
    desktopInvoke<CliResultDto>("pi_cli", {
      args,
      cwd: cwd ?? null,
    }),

  runSkillsCli: (args: string[], cwd?: string | null) =>
    desktopInvoke<CliResultDto>("skills_cli", {
      args,
      cwd: cwd ?? null,
    }),

  searchSkills: (query: string, limit: number) =>
    desktopInvoke<SkillCatalogHitDto[]>("skills_search", { query, limit }),

  checkPiCliUpdate: () => desktopInvoke<PiCliUpdateInfo>("pi_cli_update_check"),

  readSkillFile: (path: string) => desktopInvoke<string>("fs_read_file", { path }),

  listSkillDirectory: (path: string) =>
    desktopInvoke<PiSkillDirectoryEntryDto[]>("fs_list_dir", { path }),
};

export function createDesktopPiConfigurationPort(): PiConfigurationPort {
  return desktopPiConfigurationPort;
}
