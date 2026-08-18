"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { TooltipProvider } from "@appica/ui-react/tooltip";
import { NavRail } from "./NavRail";
import { ExtensionSheet } from "./ExtensionSheet";
import { SubagentDetail } from "./Subagents";
import { CliUpdateToast } from "./CliUpdateToast";
import { useCliUpdate } from "@/lib/pi/cli-update";
import { usePi } from "@/lib/pi/store";
import { useChat } from "@/lib/pi/chat";
import {
  configureSessionProjectRootResolver,
  useSessions,
  peekLatestSessionPath,
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
import { showPetWindow } from "@/lib/pet/commands";
import { requestClose } from "@/lib/window-close";
import { CloseConfirmDialog } from "./CloseConfirmDialog";
import type { PetConfigUpdate } from "@/lib/pet/types";
import {
  getBackendKind,
  getPort,
} from "@/lib/backend/composition/container";
import { configureChatRecovery } from "@/lib/orchestration/chat-recovery";

const chatRecoveryService = {
  getTarget() {
    const root = useWorkspace.getState().root ?? undefined;
    const state = useSessions.getState();
    const session = state.sessions.find((item) => item.id === state.activeId);
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
  const connect = usePi((s) => s.connect);

  useEffect(() => {
    // restore the saved UI language (or detect from the system) before first paint settles
    useI18n.getState().initLocale();
    // restore the saved light/dark theme before the appearance overrides land
    useUI.getState().initTheme();
    // restore the saved window close behavior (ask / minimize / quit)
    useUI.getState().initCloseBehavior();
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
    useChat.getState().init();
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
      // peek the newest session's path for THIS project BEFORE connecting so pi
      // can spawn with `--session <path>` and load the full prior context
      // in-process — the later `switch_session` RPC inside sessions.init() is
      // only a fallback
      .then(async () => {
        const root = useWorkspace.getState().root ?? undefined;
        const resumePath = await peekLatestSessionPath(root ?? "");
        await connect({
          cwd: root,
          resumePath: resumePath || undefined,
        });
      })
      // session history restores after connect so the UI repaints the transcript
      .then(() => useSessions.getState().init(useWorkspace.getState().root ?? ""))

      // background pi CLI version check — pops the update toast when newer
      .then(() => useCliUpdate.getState().checkOnLaunch())
      .catch((cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        usePi.setState({ status: "disconnected", lastError: error.message });
        console.error("[AppShell] backend bootstrap failed:", error);
      });

    // Esc collapses the subagent detail back into its card
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useSubagents.getState().focusedId) {
        e.stopPropagation();
        useSubagents.getState().focus(null);
      }
    };
    window.addEventListener("keydown", onKey, true);

    // Disable the browser's native context menu so custom menus can show
    const preventDefaultCtx = (e: MouseEvent) => e.preventDefault();
    const isDesktop = getBackendKind() === "desktop-tauri";
    if (isDesktop) {
      document.addEventListener("contextmenu", preventDefaultCtx);
    }

    // Intercept the window close request (caption button, Alt+F4, native close)
    // so we can honor the user's saved behavior instead of always quitting.
    let closeUnlisten: (() => void) | undefined;
    let disposed = false;
    if (isDesktop) {
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
    }

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("contextmenu", preventDefaultCtx);
      destroyAgentBridge();
      closeUnlisten?.();
    };
  }, [connect]);

  // Auto-launch the pet companion on startup when the user previously enabled
  // it — instead of waiting until they open PetSettings. (PetSettings also does
  // this on its own mount, but it only mounts when the settings page is open.)
  useEffect(() => {
    if (getBackendKind() !== "desktop-tauri") return;
    const prefs = loadPetPreferences();
    if (!prefs.enabled || !prefs.petId) return;
    void loadBuiltinPet(prefs.petId)
      .then((pet) => {
        usePet.getState().loadPet(pet);
        void showPetWindow();
        getPort("petWindow")
          .emitConfigUpdate({ petId: prefs.petId } satisfies PetConfigUpdate)
          .catch(() => {});
      })
      .catch((e) => console.error("[AppShell] failed to auto-launch pet:", e));
  }, []);

  return (
    <TooltipProvider delay={400}>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }} data-testid="app-shell">
        <NavRail />
        <div style={{ flex: 1, minWidth: 0, height: "100%" }}>{children}</div>
        <ExtensionSheet />
        <SubagentDetail />
        <CliUpdateToast />
        <CloseConfirmDialog />
      </div>
    </TooltipProvider>
  );
}
