"use client";

import { create } from "zustand";
import type {
  AgentBrowserStatusDto,
  ApprovalInfoDto,
  BrowserStatusDto,
} from "@/lib/backend/ports";
import { getPort } from "@/lib/backend/composition/container";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Screenshot loop pacing — captures a page frame at most every 450ms and
 * always after a state change, keeping CDP traffic light while the pane
 * still feels live.
 */
const FRAME_INTERVAL_MS = 450;

interface BrowserUiState {
  status: BrowserStatusDto | null;
  loading: boolean;
  /** Live view frame (data URL of the last captured screenshot). */
  frame: string | null;
  /** True when the last frame may be outdated (screenshot failed). */
  frameStale: boolean;
  /** Address bar draft — separate from the committed status.url. */
  urlDraft: string;
  /** Pending origin approval surfaced as a modal. */
  approval: ApprovalInfoDto | null;
  /** Approved origins (hosts the agent may navigate to without prompting). */
  allowlist: string[];
  /** Upstream `agent-browser` CLI status (pi's `agent_browser` tool backend). */
  agentStatus: AgentBrowserStatusDto | null;
  /** True while `npm install -g agent-browser` is running. */
  agentInstalling: boolean;
  /** Last action error (toast-able). */
  lastError: string | null;

  refresh: () => Promise<void>;
  start: () => Promise<boolean>;
  stop: () => Promise<boolean>;
  navigate: (url: string) => Promise<boolean>;
  go: () => Promise<void>;
  approveOrigin: (allow: boolean) => Promise<void>;
  loadAllowlist: () => Promise<void>;
  removeAllowedOrigin: (origin: string) => Promise<void>;
  refreshAgentCheck: () => Promise<void>;
  installAgentBrowser: () => Promise<void>;
  captureFrame: () => Promise<void>;
  click: (x: number, y: number) => Promise<void>;
  setUrlDraft: (url: string) => void;
  reload: () => Promise<void>;
  back: () => Promise<void>;
  forward: () => Promise<void>;
  reportError: (message: string) => void;
  clearError: () => void;
  dispose: () => void;
}

let frameTimer: ReturnType<typeof setInterval> | null = null;
let unlistenState: (() => void) | null = null;
let unlistenApproval: (() => void) | null = null;
let unlistenConsole: (() => void) | null = null;

function port() {
  return getPort("browser");
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export const useBrowser = create<BrowserUiState>()((set, get) => {
  const refresh = async () => {
    try {
      const status = await port().status();
      set({ status, loading: false });
      if (status.url && !get().urlDraft) {
        set({ urlDraft: status.url });
      }
    } catch (error) {
      set({ loading: false, lastError: errorMessage(error) });
    }
  };

  const captureFrame = async () => {
    const status = get().status;
    if (!status?.running) return;
    try {
      const data = await port().screenshot();
      if (data) set({ frame: `data:image/jpeg;base64,${data}`, frameStale: false });
    } catch {
      // Transient screenshot failures (mid-navigation) are non-fatal. Keep the
      // last good frame but mark it stale so the UI can hint at it.
      set({ frameStale: true });
    }
  };

  const startLoop = async () => {
    await refresh();
    if (frameTimer) clearInterval(frameTimer);
    frameTimer = setInterval(() => {
      // Skip the loop while a navigation is in flight (frames are useless mid
      // redirect) and when the browser has stopped.
      const status = get().status;
      if (!status?.running || status.loading) return;
      void captureFrame();
    }, FRAME_INTERVAL_MS);
  };

  return {
    status: null,
    loading: true,
    frame: null,
    frameStale: false,
    urlDraft: "",
    approval: null,
    allowlist: [],
    agentStatus: null,
    agentInstalling: false,
    lastError: null,

    refresh,

    start: async () => {
      set({ loading: true });
      try {
        await port().start();
        await startLoop();
        await get().loadAllowlist();
        return true;
      } catch (error) {
        set({ loading: false, lastError: errorMessage(error) });
        return false;
      }
    },

    stop: async () => {
      try {
        await port().stop();
        if (frameTimer) {
          clearInterval(frameTimer);
          frameTimer = null;
        }
        set({ status: { running: false, loading: false }, frame: null, frameStale: false });
        return true;
      } catch (error) {
        set({ lastError: errorMessage(error) });
        return false;
      }
    },

    navigate: async (raw) => {
      const url = normalizeUrl(raw);
      if (!url) return false;
      set({ urlDraft: url, lastError: null });
      try {
        const result = await port().navigate(url);
        if (result.needsApproval && result.approval) {
          set({ approval: result.approval });
          return false;
        }
        await refresh();
        return result.ok;
      } catch (error) {
        set({ lastError: errorMessage(error) });
        return false;
      }
    },

    go: async () => {
      await get().navigate(get().urlDraft);
    },

    approveOrigin: async (allow) => {
      const approval = get().approval;
      if (!approval) return;
      set({ approval: null });
      try {
        const result = await port().approveOrigin(approval.id, allow);
        if (allow && result.ok) {
          await refresh();
          void captureFrame();
        }
        // Keep the allowlist fresh whether or not the user approved.
        if (allow) await get().loadAllowlist();
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    loadAllowlist: async () => {
      try {
        const allowlist = await port().allowlist();
        set({ allowlist });
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    removeAllowedOrigin: async (origin) => {
      try {
        await port().removeOrigin(origin);
        set({ allowlist: get().allowlist.filter((item) => item !== origin) });
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    refreshAgentCheck: async () => {
      try {
        const agentStatus = await port().checkAgentBrowser();
        set({ agentStatus });
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    installAgentBrowser: async () => {
      set({ agentInstalling: true, lastError: null });
      try {
        const result = await port().installAgentBrowser();
        set({ agentStatus: result.status });
        if (!result.ok) {
          const reason = (result.status.error ?? result.log.trim()) || "install failed";
          set({ lastError: reason });
        }
      } catch (error) {
        set({ lastError: errorMessage(error) });
      } finally {
        set({ agentInstalling: false });
      }
    },

    captureFrame,

    click: async (x, y) => {
      try {
        await port().click(x, y);
        await captureFrame();
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    setUrlDraft: (url) => set({ urlDraft: url }),

    reload: async () => {
      try {
        await port().reload();
        await refresh();
        void captureFrame();
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    back: async () => {
      try {
        await port().back();
        await refresh();
        void captureFrame();
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    forward: async () => {
      try {
        await port().forward();
        await refresh();
        void captureFrame();
      } catch (error) {
        set({ lastError: errorMessage(error) });
      }
    },

    reportError: (message) => set({ lastError: message }),
    clearError: () => set({ lastError: null }),

    dispose: () => {
      if (frameTimer) {
        clearInterval(frameTimer);
        frameTimer = null;
      }
      unlistenState?.();
      unlistenApproval?.();
      unlistenConsole?.();
      unlistenState = null;
      unlistenApproval = null;
      unlistenConsole = null;
    },
  };
});

/** Wire Tauri events once (idempotent) — call on pane mount. */
export async function initBrowserEvents(): Promise<void> {
  if (unlistenState) return;
  unlistenState = await port().onState((status) => {
    useBrowser.setState({ status });
    if (status.url) useBrowser.setState({ urlDraft: status.url });
    if (!status.loading) void useBrowser.getState().captureFrame();
  });
  unlistenApproval = await port().onApproval((approval) => {
    useBrowser.setState({ approval });
  });
  unlistenConsole = await port().onConsole((text) => {
    // Console output is surfaced through the agent's own view; the pane just
    // keeps it out of the way for now.
    void text;
  });
}
