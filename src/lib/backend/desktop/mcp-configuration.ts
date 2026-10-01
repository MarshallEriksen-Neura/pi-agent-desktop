import type { ExecutionBinding } from "../ports/execution-target";
import type { McpConfigurationPort, McpInspectionDto } from "../ports/mcp-configuration";
import type { McpDiscoverySourceDto, SettingsScopeFileDto } from "../ports/pi-configuration";
import { t } from "../../i18n";
import { remotePiManagementRequest, RemotePiManagementError, RemotePiManagementUnavailableError, type RemotePiManagementDependencies } from "./remote-pi-management";

type RemoteMcpFile = SettingsScopeFileDto & { stateToken: string };

export function createDesktopRemoteMcpConfiguration(
  binding: Extract<ExecutionBinding, { kind: "ssh" }>,
  dependencies?: RemotePiManagementDependencies,
): McpConfigurationPort {
  const request = async <T>(body: Record<string, unknown>): Promise<T> => {
    try { return await remotePiManagementRequest<T>(binding, body, dependencies); }
    catch (error) {
      if (error instanceof RemotePiManagementUnavailableError) throw new Error(t("mcp.remoteUpgrade"));
      const keys: Record<string, string> = {
        configurationChanged: "mcp.remoteConfigurationChanged", configurationBusy: "mcp.remoteConfigurationBusy",
        mcpProjectIgnored: "mcp.remoteProjectIgnored", invalidMcpConfiguration: "mcp.invalidJson",
        mcpConfigTooLarge: "mcp.remoteConfigTooLarge", mcpConfigUnreadable: "mcp.remoteUnreadable",
        symlinkRejected: "mcp.remoteUnreadable",
      };
      throw new Error(t(error instanceof RemotePiManagementError ? keys[error.code] ?? "mcp.remoteConfigFailed" : "mcp.remoteConfigFailed"));
    }
  };
  const inspect = () => request<McpInspectionDto>({ operation: "inspectMcp" });
  return {
    inspectStatus: () => remotePiManagementRequest<McpInspectionDto>(binding, { operation: "inspectMcp" }, dependencies),
    readMcpConfig: (scope) => request<RemoteMcpFile>({ operation: "readMcpConfig", scope }),
    writeMcpConfig: async (scope, content, expectedState) => {
      if (!expectedState) throw new Error(t("mcp.remoteReloadBeforeSave"));
      return request<RemoteMcpFile>({ operation: "writeMcpConfig", scope, expectedState, content });
    },
    checkMcpAdapter: async () => {
      const status = await inspect();
      const owned = new Set([`${status.agentDirectory}/mcp.json`, `${binding.remoteCwd}/.pi/mcp.json`]);
      return { installed: status.adapterRegistered === true || status.adapterPackagePresent === true,
        otherConfigPaths: status.sources.filter((source) => source.exists && !owned.has(source.path)).map((source) => source.path) };
    },
    discoverMcpSources: () => request<McpDiscoverySourceDto[]>({ operation: "discoverMcpSources" }),
    // A remote directory/installer must never be routed to the local OS or Pi.
    openMcpConfigDirectory: async () => { throw new Error(t("mcp.remoteDirectoryUnavailable")); },
    installAdapter: async () => { throw new Error(t("mcp.remoteManualSetup")); },
  };
}
