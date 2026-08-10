import type {
  RemoteControlAllowProjectInput,
  RemoteControlEnableInput,
  RemoteControlPort,
  RemoteControlStatusDto,
} from "../ports";
import type {
  PairingDeviceMetadata,
  PairingQrPayload,
  RemoteProjectSummary,
} from "@pi/remote-control-contracts";

/**
 * Browser-preview mock for {@link RemoteControlPort}.
 *
 * `pnpm dev` runs without Tauri, so this port keeps an in-memory gateway state
 * that lets the Settings page be fully navigable: the overview starts in a
 * healthy "enabled" state with one paired device and one authorized project so
 * every group has content to render. Toggling, adding, removing, and resetting
 * mutate that state so flows can be exercised end-to-end in the browser.
 *
 * Delays are intentionally small (120–320 ms) to surface loading states
 * without making the UI feel sluggish. To preview the "paired success" QR
 * modal flow, the initial state already includes a device; removing it
 * exercises the empty state.
 */

const MOCK_DESKTOP_ID = "pi-desktop-mock-01";
const MOCK_DESKTOP_NAME = "Pi Desktop";
const MOCK_HOST = "192.168.1.100";
const MOCK_PORT = 8443;
/** Fake SPKI SHA-256 pin (44-char base64) — mock only, never a real secret. */
const MOCK_CERT_PIN_VALUE = "mE0+VQZ4nFp7bq2gRKx3YvT9cJ1aHs6dUwL8eZkNtIo=";
const QR_TTL_MS = 5 * 60_000;

interface MockState {
  enabled: boolean;
  degraded: boolean;
  selectedAddresses: string[];
  port: number | null;
  identityEpoch: number;
  projects: RemoteProjectSummary[];
  pairedDevices: PairingDeviceMetadata[];
  lastError: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function deriveName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function makeProjectId(path: string): string {
  const slug = deriveName(path).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `proj_${slug}_${Math.random().toString(36).slice(2, 8)}`;
}

function initialState(): MockState {
  return {
    enabled: true,
    degraded: false,
    selectedAddresses: [MOCK_HOST],
    port: MOCK_PORT,
    identityEpoch: 1,
    projects: [
      {
        projectId: "proj_demo-app_abc123",
        name: "demo-app",
        lastOpenedAt: iso(-3_600_000),
      },
    ],
    pairedDevices: [
      {
        deviceId: "dev_iphone_x9f2k",
        displayName: "iPhone 15 Pro",
        platform: "ios",
        appVersion: "0.4.1",
      },
    ],
    lastError: null,
  };
}

function snapshot(state: MockState): RemoteControlStatusDto {
  return {
    enabled: state.enabled,
    degraded: state.degraded,
    selectedAddresses: [...state.selectedAddresses],
    port: state.port,
    identityEpoch: state.identityEpoch,
    projects: state.projects.map((p) => ({ ...p })),
    pairedDevices: state.pairedDevices.map((d) => ({ ...d })),
    lastError: state.lastError,
  };
}

function makeQrPayload(state: MockState): PairingQrPayload {
  return {
    protocol: "pi.remote-control",
    version: 1,
    desktop: {
      desktopId: MOCK_DESKTOP_ID,
      displayName: MOCK_DESKTOP_NAME,
    },
    endpoints: state.selectedAddresses.map((host) => ({
      scheme: "https",
      host,
      port: state.port ?? MOCK_PORT,
    })),
    pairingId: `pair_${Math.random().toString(36).slice(2, 12)}`,
    secret: `${Math.random().toString(36).slice(2, 20)}${Math.random().toString(36).slice(2, 20)}`,
    certificatePin: {
      algorithm: "spki-sha256",
      value: MOCK_CERT_PIN_VALUE,
    },
    expiresAt: iso(QR_TTL_MS),
  };
}

export function createMockRemoteControlPort(): RemoteControlPort {
  let state: MockState = initialState();

  return {
    status: async () => {
      await delay(120);
      return snapshot(state);
    },

    enable: async (input: RemoteControlEnableInput) => {
      await delay(220);
      state = {
        ...state,
        enabled: true,
        degraded: false,
        selectedAddresses: [...input.selectedAddresses],
        port: input.port,
        lastError: null,
      };
      return snapshot(state);
    },

    disable: async () => {
      await delay(220);
      state = {
        ...state,
        enabled: false,
        degraded: false,
      };
      return snapshot(state);
    },

    pairingPayload: async () => {
      await delay(150);
      return makeQrPayload(state);
    },

    allowProject: async (input: RemoteControlAllowProjectInput) => {
      await delay(180);
      const summary: RemoteProjectSummary = {
        projectId: makeProjectId(input.path),
        name: input.name ?? deriveName(input.path),
        lastOpenedAt: iso(),
      };
      state = {
        ...state,
        projects: [...state.projects, summary],
      };
      return summary;
    },

    removeProject: async (projectId: string) => {
      await delay(180);
      state = {
        ...state,
        projects: state.projects.filter((p) => p.projectId !== projectId),
      };
      return snapshot(state);
    },

    revokeDevice: async (deviceId: string) => {
      await delay(180);
      state = {
        ...state,
        pairedDevices: state.pairedDevices.filter((d) => d.deviceId !== deviceId),
      };
      return snapshot(state);
    },

    resetIdentity: async () => {
      await delay(320);
      state = {
        ...state,
        identityEpoch: state.identityEpoch + 1,
        pairedDevices: [],
      };
      return snapshot(state);
    },
  };
}

export const mockRemoteControlPort = createMockRemoteControlPort();
