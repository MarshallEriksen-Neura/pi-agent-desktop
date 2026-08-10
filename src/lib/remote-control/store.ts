"use client";

import { create } from "zustand";
import type {
  RemoteControlAllowProjectInput,
  RemoteControlEnableInput,
  RemoteControlStatusDto,
} from "@/lib/backend/ports";
import type { PairingQrPayload } from "@pi/remote-control-contracts";
import { getPort } from "@/lib/backend/composition/container";
import { DEFAULT_PORT, PAIRING_POLL_INTERVAL_MS } from "./constants";
import { qrRemainingMs } from "./qr";
import type { PairingQrState } from "./types";

/**
 * Module-private timer for the pairing-success poll (design §13-3). Kept out of
 * store state so the snapshot stays serializable; lifecycle is owned by
 * {@link RemoteControlState.startPairingPoll} / {@link stopPairingPoll}.
 */
let pairPollTimer: ReturnType<typeof setInterval> | null = null;

/** Resolve the active port once per call — `getPort` returns a cached singleton. */
function port() {
  return getPort("remoteControl");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface RemoteControlState {
  /** Latest gateway snapshot; null until the first `refresh` resolves. */
  status: RemoteControlStatusDto | null;
  /** True until the first `status()` resolves (initial load skeleton). */
  loading: boolean;
  /** Enable/disable in flight — drives the `starting` phase. */
  enabling: boolean;
  /** Most recent operation-level error (distinct from `status.lastError`). */
  lastError: string | null;

  /** Current QR ticket; null when no QR has been generated. */
  qrPayload: PairingQrPayload | null;
  qrState: PairingQrState;
  /** True while the QR modal polls `status` for a successful pairing. */
  pairingPolling: boolean;

  /** Network-config draft — shared by the overview toggle and config group. */
  draftAddresses: string[];
  draftPort: number;

  // actions
  refresh: () => Promise<void>;
  enable: (input: RemoteControlEnableInput) => Promise<boolean>;
  disable: () => Promise<boolean>;
  generateQr: () => Promise<void>;
  startPairingPoll: () => void;
  stopPairingPoll: () => void;
  allowProject: (input: RemoteControlAllowProjectInput) => Promise<boolean>;
  removeProject: (projectId: string) => Promise<boolean>;
  revokeDevice: (deviceId: string) => Promise<boolean>;
  resetIdentity: () => Promise<boolean>;
  setDraftAddresses: (addresses: string[]) => void;
  setDraftPort: (port: number) => void;
  clearError: () => void;
}

export const useRemoteControl = create<RemoteControlState>()((set, get) => ({
  status: null,
  loading: true,
  enabling: false,
  lastError: null,
  qrPayload: null,
  qrState: "idle",
  pairingPolling: false,
  draftAddresses: [],
  draftPort: DEFAULT_PORT,

  refresh: async () => {
    try {
      const next = await port().status();
      set((prev) => ({
        status: next,
        loading: false,
        // Sync the draft to the persisted config when the gateway reports one,
        // so the toggle + config group reflect reality on load. User edits win
        // while the gateway is disabled (no selectedAddresses to clobber with).
        draftAddresses:
          next.selectedAddresses.length > 0
            ? [...next.selectedAddresses]
            : prev.draftAddresses,
        draftPort: next.port ?? prev.draftPort,
      }));
    } catch (e) {
      set({ loading: false, lastError: errorMessage(e) });
    }
  },

  enable: async (input) => {
    set({ enabling: true, lastError: null });
    try {
      const next = await port().enable(input);
      set({ status: next, enabling: false });
      return true;
    } catch (e) {
      set({ enabling: false, lastError: errorMessage(e) });
      return false;
    }
  },

  disable: async () => {
    set({ enabling: true, lastError: null });
    try {
      const next = await port().disable();
      set({
        status: next,
        enabling: false,
        qrState: "idle",
        qrPayload: null,
      });
      get().stopPairingPoll();
      return true;
    } catch (e) {
      set({ enabling: false, lastError: errorMessage(e) });
      return false;
    }
  },

  generateQr: async () => {
    set({ qrState: "generating", lastError: null });
    try {
      const payload = await port().pairingPayload();
      set({ qrPayload: payload, qrState: "ready" });
    } catch (e) {
      set({ qrState: "failed", lastError: errorMessage(e) });
    }
  },

  startPairingPoll: () => {
    if (pairPollTimer) return;
    const baseline = get().status?.pairedDevices.length ?? 0;
    set({ pairingPolling: true });
    pairPollTimer = setInterval(async () => {
      const s = get();
      if (!s.qrPayload) {
        s.stopPairingPoll();
        return;
      }
      if (qrRemainingMs(s.qrPayload.expiresAt) <= 0) {
        set({ qrState: "expired" });
        s.stopPairingPoll();
        return;
      }
      await s.refresh();
      const count = get().status?.pairedDevices.length ?? 0;
      if (count > baseline) {
        set({ qrState: "paired" });
        get().stopPairingPoll();
      }
    }, PAIRING_POLL_INTERVAL_MS);
  },

  stopPairingPoll: () => {
    if (pairPollTimer) {
      clearInterval(pairPollTimer);
      pairPollTimer = null;
    }
    set({ pairingPolling: false });
  },

  allowProject: async (input) => {
    set({ lastError: null });
    try {
      await port().allowProject(input);
      await get().refresh();
      return true;
    } catch (e) {
      set({ lastError: errorMessage(e) });
      return false;
    }
  },

  removeProject: async (projectId) => {
    set({ lastError: null });
    try {
      const next = await port().removeProject(projectId);
      set({ status: next });
      return true;
    } catch (e) {
      set({ lastError: errorMessage(e) });
      return false;
    }
  },

  revokeDevice: async (deviceId) => {
    set({ lastError: null });
    try {
      const next = await port().revokeDevice(deviceId);
      set({ status: next });
      return true;
    } catch (e) {
      set({ lastError: errorMessage(e) });
      return false;
    }
  },

  resetIdentity: async () => {
    set({ lastError: null });
    try {
      const next = await port().resetIdentity();
      set({ status: next, qrState: "idle", qrPayload: null });
      get().stopPairingPoll();
      return true;
    } catch (e) {
      set({ lastError: errorMessage(e) });
      return false;
    }
  },

  setDraftAddresses: (addresses) => set({ draftAddresses: addresses }),
  setDraftPort: (port) => set({ draftPort: port }),
  clearError: () => set({ lastError: null }),
}));
