"use client";

import { create } from "zustand";
import type {
  AuthNotifyDto,
  AuthPromptDto,
  AuthProviderDto,
  ProviderAuthEventDto,
  ProviderAuthMethod,
} from "@/lib/backend/ports";
import { getPort } from "@/lib/backend/composition/container";

/** Error string emitted when the login watchdog fires. */
export const LOGIN_TIMEOUT = "login-timeout";

/** Where the active login has got to. */
export type LoginPhase =
  | "starting"
  | "waiting-browser"
  | "awaiting-input"
  | "finishing"
  | "done"
  | "error";

export interface ActiveLogin {
  providerId: string;
  method: ProviderAuthMethod;
  phase: LoginPhase;
  /** Authorization URL, kept after opening so it can be copied or reopened. */
  authUrl: string | null;
  /** Device-code details, for providers that use that flow (Copilot). */
  deviceCode: Extract<AuthNotifyDto, { type: "device_code" }> | null;
  /** Latest progress line from pi. */
  progress: string | null;
  /** Informational message with optional links. */
  info: Extract<AuthNotifyDto, { type: "info" }> | null;
  /** Pending question; null when nothing is being asked. */
  prompt: (AuthPromptDto & { requestId: string }) | null;
  /** True while an answer is in flight, to keep the submit button disabled. */
  answering: boolean;
  error: string | null;
}

function providerAuth() {
  return getPort("providerAuth");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ProviderAuthState {
  providers: AuthProviderDto[];
  /** True until the first `refresh` settles. */
  loading: boolean;
  /** Error from listing/logout, distinct from a login-flow error. */
  lastError: string | null;
  /** Provider id whose logout is in flight. */
  loggingOut: string | null;
  active: ActiveLogin | null;

  refresh: () => Promise<void>;
  beginLogin: (providerId: string, method: ProviderAuthMethod) => Promise<void>;
  submitAnswer: (value: string) => Promise<void>;
  cancelLogin: () => Promise<void>;
  dismissLogin: () => void;
  logout: (providerId: string) => Promise<void>;
  clearError: () => void;
  /** Subscribe to port events. Returns an unsubscribe function. */
  subscribe: () => () => void;
}

export const useProviderAuth = create<ProviderAuthState>()((set, get) => ({
  providers: [],
  loading: true,
  lastError: null,
  loggingOut: null,
  active: null,

  refresh: async () => {
    try {
      const providers = await providerAuth().listProviders();
      set({ providers, loading: false });
    } catch (e) {
      set({ loading: false, lastError: errorMessage(e) });
    }
  },

  beginLogin: async (providerId, method) => {
    set({
      lastError: null,
      active: {
        providerId,
        method,
        phase: "starting",
        authUrl: null,
        deviceCode: null,
        progress: null,
        info: null,
        prompt: null,
        answering: false,
        error: null,
      },
    });
    try {
      await providerAuth().beginLogin(providerId, method);
    } catch (e) {
      const message = errorMessage(e);
      set((prev) =>
        prev.active ? { active: { ...prev.active, phase: "error", error: message } } : {}
      );
    }
  },

  submitAnswer: async (value) => {
    const active = get().active;
    if (!active?.prompt) return;
    const { requestId } = active.prompt;
    // Clear the prompt immediately: pi has one question outstanding at a time,
    // and leaving it rendered invites a double submit against a stale id.
    set({ active: { ...active, prompt: null, answering: true, phase: "finishing" } });
    try {
      await providerAuth().answerPrompt(requestId, value);
      set((prev) => (prev.active ? { active: { ...prev.active, answering: false } } : {}));
    } catch (e) {
      set((prev) =>
        prev.active
          ? {
              active: {
                ...prev.active,
                answering: false,
                phase: "error",
                error: errorMessage(e),
              },
            }
          : {}
      );
    }
  },

  cancelLogin: async () => {
    try {
      await providerAuth().cancelLogin();
    } catch {
      // Cancelling is best-effort: the sidecar is killed regardless, so a
      // failure here must not keep a dead dialog on screen.
    }
    set({ active: null });
  },

  dismissLogin: () => set({ active: null }),

  logout: async (providerId) => {
    set({ loggingOut: providerId, lastError: null });
    try {
      await providerAuth().logout(providerId);
      set({ loggingOut: null });
      await get().refresh();
    } catch (e) {
      set({ loggingOut: null, lastError: errorMessage(e) });
    }
  },

  clearError: () => set({ lastError: null }),

  subscribe: () =>
    providerAuth().onEvent((event) => {
      const active = get().active;
      // Events can arrive after a dismiss; ignore them rather than resurrecting
      // a dialog the user already closed.
      if (!active) return;
      set({ active: applyEvent(active, event) });
      if (event.kind === "done") {
        // Refresh so the row's stored-credential badge reflects the new state.
        void get().refresh();
      }
    }),
}));

function applyNotify(active: ActiveLogin, event: AuthNotifyDto): ActiveLogin {
  switch (event.type) {
    case "auth_url":
      return { ...active, phase: "waiting-browser", authUrl: event.url };
    case "device_code":
      return { ...active, phase: "waiting-browser", deviceCode: event };
    case "progress":
      return { ...active, progress: event.message };
    case "info":
      return { ...active, info: event };
  }
}

/**
 * Fold one flow event into the active-login state. Pure, so it is testable.
 *
 * Returns null when the flow is over and the dialog should close — which is
 * what `cancelled` means, whether the user asked or the helper's stdin closed.
 */
export function applyEvent(
  active: ActiveLogin,
  event: ProviderAuthEventDto
): ActiveLogin | null {
  switch (event.kind) {
    case "ready":
      return { ...active, phase: "starting" };
    case "notify":
      return applyNotify(active, event.event);
    case "prompt":
      return {
        ...active,
        phase: "awaiting-input",
        prompt: { ...event.prompt, requestId: event.requestId },
      };
    case "done":
      return { ...active, phase: "done", prompt: null, error: null };
    case "cancelled":
      return null;
    case "error":
      return { ...active, phase: "error", prompt: null, error: event.message };
  }
}
