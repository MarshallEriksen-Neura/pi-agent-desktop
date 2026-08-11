import type {
  RemoteControlAllowProjectInput,
  RemoteControlEnableInput,
  RemoteControlPort,
  RemoteControlStatusDto,
} from "../ports";
import type {
  PairingQrPayload,
  RemoteProjectSummary,
} from "@pi/remote-control-contracts";
import { desktopInvoke } from "./invoke";

/**
 * Tauri IPC implementation of {@link RemoteControlPort}.
 *
 * Every method is a thin `desktopInvoke` over the commands registered in
 * `src-tauri/src/lib.rs`. Argument names follow Tauri's snake_case →
 * camelCase convention (`project_id` → `projectId`); the `enable` command
 * takes a single `request` struct argument (see `remote_control_enable` in
 * `mod.rs` and the command smoke test).
 */
export const desktopRemoteControlPort: RemoteControlPort = {
  status: () => desktopInvoke<RemoteControlStatusDto>("remote_control_status"),

  privateAddresses: () =>
    desktopInvoke<string[]>("remote_control_private_addresses"),

  enable: (input: RemoteControlEnableInput) =>
    desktopInvoke<RemoteControlStatusDto>("remote_control_enable", {
      request: {
        selectedAddresses: [...input.selectedAddresses],
        port: input.port,
      },
    }),

  disable: () => desktopInvoke<RemoteControlStatusDto>("remote_control_disable"),

  pairingPayload: () =>
    desktopInvoke<PairingQrPayload>("remote_control_pairing_payload"),

  allowProject: (input: RemoteControlAllowProjectInput) =>
    desktopInvoke<RemoteProjectSummary>("remote_control_allow_project", {
      path: input.path,
      name: input.name,
    }),

  removeProject: (projectId: string) =>
    desktopInvoke<RemoteControlStatusDto>("remote_control_remove_project", {
      projectId,
    }),

  revokeDevice: (deviceId: string) =>
    desktopInvoke<RemoteControlStatusDto>("remote_control_revoke_device", {
      deviceId,
    }),

  resetIdentity: () =>
    desktopInvoke<RemoteControlStatusDto>("remote_control_reset_identity"),
};
