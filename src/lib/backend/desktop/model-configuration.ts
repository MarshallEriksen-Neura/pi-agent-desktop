import type { ExecutionBinding } from "../ports/execution-target";
import type { RemoteModelConfigurationPort, RemoteModelSnapshot } from "../ports/model-configuration";
import { remotePiManagementRequest, type RemotePiManagementDependencies } from "./remote-pi-management";

export function createDesktopRemoteModelConfiguration(
  binding: Extract<ExecutionBinding, { kind: "ssh" }>,
  dependencies?: RemotePiManagementDependencies,
): RemoteModelConfigurationPort {
  const request = <T>(body: Record<string, unknown>) => remotePiManagementRequest<T>(binding, body, dependencies);
  return {
    read: (scope) => request<RemoteModelSnapshot>({ operation: "inspectModels", scope }),
    mutate: (scope, expectedState, changes) => request<RemoteModelSnapshot>({ operation: "mutateModels", scope, expectedState, changes }),
    setEnabled: (scope, expectedState, enabledModels) => request<RemoteModelSnapshot>({ operation: "setEnabledModels", scope, expectedState, enabledModels }),
    fetchModels: (scope, providerId) => request<string[]>({ operation: "fetchProviderModels", scope, providerId }),
  };
}
