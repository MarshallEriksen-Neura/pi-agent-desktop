"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { TooltipProvider } from "@appica/ui-react/tooltip";
import { NavRail } from "./NavRail";
import { ExtensionSheet } from "./ExtensionSheet";
import { CliUpdateToast } from "./CliUpdateToast";
import { useCliUpdate } from "@/lib/pi/cli-update";
import { usePi } from "@/lib/pi/store";
import {
  configureSessionProjectRootResolver,
  useSessions,
} from "@/lib/pi/sessions";
import { useExtUi } from "@/lib/pi/ext-ui";
import { useSubagents } from "@/lib/pi/subagents";
import { destroyAgentBridge, initAgentBridge } from "@/lib/pi/agent-bridge";
import { useWorkspace } from "@/lib/workspace";
import { useRuntime } from "@/lib/pi/runtime";
import { useI18n } from "@/lib/i18n";
import { useAppearance } from "@/lib/appearance";
import { useUI } from "@/lib/store";
import { usePet } from "@/lib/pet/store";
import { loadBuiltinPet } from "@/lib/pet/index";
import { loadPetPreferences } from "@/lib/pet/persistence";
import { prewarmPetWindow, showPetWindow } from "@/lib/pet/commands";
import { runWhenIdle } from "@/lib/idle";
import { requestClose } from "@/lib/window-close";
import { CloseConfirmDialog } from "./CloseConfirmDialog";
import type { PetConfigUpdate } from "@/lib/pet/types";
import {
  getBackendKind,
  getPort,
} from "@/lib/backend/composition/container";
import { configureChatRecovery } from "@/lib/orchestration/chat-recovery";

const chatRecoveryService = {
  getTarget(taskId?: string) {
    const root = useWorkspace.getState().root ?? undefined;
    const state = useSessions.getState();
    const id = taskId || state.activeId;
    const session = state.sessions.find((item) => item.id === id);
    return { cwd: root, resumePath: session?.sessionPath || undefined };
  },
};

/** Root chrome: nav rail + page content. Connects to pi on mount. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The pet companion runs in its own tiny transparent window — no app chrome,
  // and no pi connection (the main window owns the pi process).
  if (pathname?.startsWith("/pet")) {
    return <>{children}</>;
  }
  return <MainShell>{children}</MainShell>;
}

function MainShell({ children }: { children: React.ReactNode }) {
  const closeBehavior = useUI((s) => s.closeBehavior);
  useEffect(() => {
    // restore the saved UI language (or detect from the system) before first paint settles
    useI18n.getState().initLocale();
    // restore the saved light/dark theme before the appearance overrides land
    useUI.getState().initTheme();
    // restore the saved window close behavior (ask / minimize / quit)
    useUI.getState().initCloseBehavior();
    // restore startup layout + IDE preference before EditorCanvas may mount
    useUI.getState().initLayoutPreferences();
    // restore the user's dragged chat-rail width
    useUI.getState().initAgentPanelWidth();
    // restore the composer's send shortcut (⌘↩ / ↩ / ⇧↩)
    useUI.getState().initSendShortcut();
    // restore the dragged width of the subagent inspector column
    useUI.getState().initSubagentPanelWidth();
    // restore user-customized appearance (colors, background, text scale)
    useAppearance.getState().init();
    try {
      configureChatRecovery(chatRecoveryService);
    } catch (error) {
      // Next dev Fast Refresh can remount this component with a new service
      // object while the module-level singleton is intentionally preserved.
      // Keep the first service rather than taking down the whole preview.
      if (!(error instanceof Error && error.message === "Chat recovery service is already configured.")) {
        throw error;
      }
    }
    configureSessionProjectRootResolver(
      () => useWorkspace.getState().root,
    );
    // subscribe before connecting so no early events are missed
    useExtUi.getState().init();
    useSubagents.getState().initPiBridge();
    initAgentBridge(); // tool events → task strip / editor highlights / terminal + pet bridge
    // load the Windows/WSL command runtime before Pi starts; its shell bridge
    // may be used by the first agent command
    void useRuntime
      .getState()
      .load()
      // resolve the project root next so Pi and its commands share a cwd
      .then(() => useWorkspace.getState().init())
      // session history restores after the workspace resolves; sessions.init()
      // spawns the active conversation's own pi process with its saved
      // --session path, so every task runs in its own process (parallel tasks)
      .then(() => useSessions.getState().init(useWorkspace.getState().root ?? ""))

      // background pi CLI version check — pops the update toast when newer
      .then(() => useCliUpdate.getState().checkOnLaunch())
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        usePi.setState({ status: "disconnected", lastError: error.message });
        console.error("[AppShell] backend bootstrap failed:", error);
      });

    /**
     * Esc closes the subagent inspector — but it is a docked panel, not a modal,
     * so it does not own the key. While the caret is in a field, Esc belongs to
     * whatever is being typed into (the composer's slash menu, an inline rename).
     * Bubbling and without stopPropagation for the same reason: more local
     * handlers get their turn.
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !useSubagents.getState().focusedId) return;
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.isContentEditable === true;
      if (typing) return;
      useSubagents.getState().focus(null);
    };
    window.addEventListener("keydown", onKey);

    // Disable the browser's native context menu so custom menus can show
    const preventDefaultCtx = (e: MouseEvent) => e.preventDefault();
    const isDesktop = getBackendKind() === "desktop-tauri";
    if (isDesktop) {
      document.addEventListener("contextmenu", preventDefaultCtx);
    }

    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("contextmenu", preventDefaultCtx);
      destroyAgentBridge();
    };
  }, []);

  // Only ask/minimize needs a WebView close listener. In quit mode there must
  // be no JS listener at all: if the renderer is hung, a registered listener
  // can stall the native close before Rust ever sees ExitRequested.
  useEffect(() => {
    if (getBackendKind() !== "desktop-tauri" || closeBehavior === "quit") return;

    let closeUnlisten: (() => void) | undefined;
    let disposed = false;
    getPort("window")
      .onCloseRequested((event) => {
        event.preventDefault();
        requestClose();
      })
      .then((fn) => {
        if (disposed) fn();
        else closeUnlisten = fn;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      closeUnlisten?.();
    };
  }, [closeBehavior]);

  // Dismiss the boot screen once the real shell has actually painted (see
  // BootScreen). Two frames, not one: the first callback still runs *before* the
  // paint that puts this tree on screen, so dismissing there would uncover an
  // empty window for a frame.
  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!cancelled) document.documentElement.dataset.appReady = "1";
      }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-launch the pet companion on startup when the user previously enabled
  // it — instead of waiting until they open PetSettings. (PetSettings also does
  // this on its own mount, but it only mounts when the settings page is open.)
  //
  // Everything here is deferred past first paint. The pet runs in a second
  // webview that loads this same bundle, so kicking it off during mount made the
  // two windows compete for the renderer (and, in dev, for the Next compiler)
  // and pushed the main window's first screen out. The window is pre-warmed
  // *hidden* and revealed by the pet bridge once /pet reports it has content
  // (see lib/pet/bridge.ts), so the background load stays invisible.
  useEffect(() => {
    if (getBackendKind() !== "desktop-tauri") return;
    const prefs = loadPetPreferences();
    if (!prefs.enabled || !prefs.petId) return;
    const petId = prefs.petId;
    let cancelled = false;
    let revealFallback: number | undefined;

    const cancelIdle = runWhenIdle(
      () => {
        // Start the hidden webview and the manifest load in parallel: the pet
        // window loads its own copy of the pet, and the main window needs one
        // too for PetSettings and the state bridge.
        void prewarmPetWindow().catch((e) =>
          console.error("[AppShell] failed to prewarm pet window:", e),
        );
        void loadBuiltinPet(petId)
          .then((pet) => {
            if (cancelled) return;
            usePet.getState().loadPet(pet);
            return getPort("petWindow")
              .emitConfigUpdate({ petId } satisfies PetConfigUpdate)
              .catch(() => {});
          })
          .catch((e) =>
            console.error("[AppShell] failed to auto-launch pet:", e),
          );

        // Safety net: the reveal rides on the pet window's ready event. If that
        // never lands (a listen() failure inside the pet webview, say), show it
        // anyway — an enabled pet that stays invisible with no explanation is
        // worse than one that renders its own error.
        revealFallback = window.setTimeout(() => {
          if (cancelled || usePet.getState().windowVisible) return;
          const current = loadPetPreferences();
          if (!current.enabled || !current.windowVisible) return;
          void showPetWindow().catch(() => {});
        }, 6000);
      },
      { timeout: 4000 },
    );

    return () => {
      cancelled = true;
      cancelIdle();
      if (revealFallback !== undefined) window.clearTimeout(revealFallback);
    };
  }, []);

  return (
    <TooltipProvider delay={400}>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }} data-testid="app-shell">
        <NavRail />
        <div style={{ flex: 1, minWidth: 0, height: "100%" }}>{children}</div>
        <ExtensionSheet />
        <CliUpdateToast />
        <CloseConfirmDialog />
      </div>
    </TooltipProvider>
  );
}
