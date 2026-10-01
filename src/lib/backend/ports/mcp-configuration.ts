import type { ExecutionBinding } from "./execution-target";
import type { PiConfigurationPort, SettingsScopeFileDto } from "./pi-configuration";
import type { SettingsScope } from "../../pi/settings";

/** Bound to one host/project; an SSH port never calls local configuration APIs. */
export type McpConfigurationPort = Pick<PiConfigurationPort,
  "checkMcpAdapter" | "discoverMcpSources" | "openMcpConfigDirectory"
 > & {
  readMcpConfig(scope: SettingsScope): Promise<McpConfigScopeDto>;
  writeMcpConfig(scope: SettingsScope, content: string, expectedState?: string): Promise<McpConfigScopeDto | void>;
  installAdapter(): Promise<void>;
  inspectStatus?(): Promise<McpInspectionDto>;
};

export type McpConfigScopeDto = SettingsScopeFileDto & { stateToken?: string };

export type McpConfigurationPortFactory = (binding: ExecutionBinding, projectRoot?: string | null) => McpConfigurationPort;

export interface McpInspectionDto {
  agentDirectory: string;
  adapterRegistered: boolean | null;
  adapterPackagePresent: boolean | null;
  sources: Array<{
    path: string;
    exists: boolean;
    error: "unreadable" | "unsupported" | null;
    servers: Array<{ name: string; enabled: boolean }>;
  }>;
  runtimeStatus: "unverified";
}

export function localMcpConfiguration(port: PiConfigurationPort, root?: string | null): McpConfigurationPort {
  return {
    readMcpConfig: (scope) => port.readMcpConfig(scope, root),
    writeMcpConfig: (scope, content) => port.writeMcpConfig(scope, content, root),
    checkMcpAdapter: () => port.checkMcpAdapter(root),
    discoverMcpSources: () => port.discoverMcpSources(root),
    openMcpConfigDirectory: (scope) => port.openMcpConfigDirectory(scope, root),
    installAdapter: async () => {
      const result = await port.runPiCli(["install", "npm:pi-mcp-adapter"], root);
      if (result.code !== 0) throw new Error(result.stderr || result.stdout || "pi-mcp-adapter installation failed");
    },
  };
}
