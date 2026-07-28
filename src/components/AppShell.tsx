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
import { useSessions } from "@/lib/pi/sessions";
import { useExtUi } from "@/lib/pi/ext-ui";
import { useSubagents } from "@/lib/pi/subagents";
import { initAgentBridge } from "@/lib/pi/agent-bridge";
import { destroyPetBridge } from "@/lib/pet/bridge";
import { useWorkspace } from "@/lib/workspace";
import { useI18n } from "@/lib/i18n";
import { useAppearance } from "@/lib/appearance";
import { useUI } from "@/lib/store";
import { usePet } from "@/lib/pet/store";
import { loadBuiltinPet } from "@/lib/pet/index";
import { loadPetPreferences } from "@/lib/pet/persistence";
import { showPetWindow } from "@/lib/pet/commands";
import { isTauri } from "@/lib/pi/client";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { requestClose } from "@/lib/window-close";
import { CloseConfirmDialog } from "./CloseConfirmDialog";
import type { PetConfigUpdate } from "@/lib/pet/types";

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
    // subscribe before connecting so no early events are missed
    useChat.getState().init();
    useExtUi.getState().init();
    useSubagents.getState().initPiBridge();
    initAgentBridge(); // tool events → task strip / editor highlights / terminal + pet bridge
    // resolve the project root first so pi spawns inside it
    void useWorkspace
      .getState()
      .init()
      .then(() => connect({ cwd: useWorkspace.getState().root ?? undefined }))
      // session history restores after connect so pi can switch to the stored file
      .then(() => useSessions.getState().init())
      // background pi CLI version check — pops the update toast when newer
      .then(() => useCliUpdate.getState().checkOnLaunch());

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
    if (isTauri()) {
      document.addEventListener("contextmenu", preventDefaultCtx);
    }

    // Intercept the window close request (caption button, Alt+F4, native close)
    // so we can honor the user's saved behavior instead of always quitting.
    let closeUnlisten: (() => void) | undefined;
    if (isTauri()) {
      getCurrentWindow()
        .onCloseRequested((event) => {
          event.preventDefault();
          requestClose();
        })
        .then((fn) => {
          closeUnlisten = fn;
        })
        .catch(() => {});
    }

    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("contextmenu", preventDefaultCtx);
      destroyPetBridge(); // cleanup on unmount
      closeUnlisten?.();
    };
  }, [connect]);

  // Auto-launch the pet companion on startup when the user previously enabled
  // it — instead of waiting until they open PetSettings. (PetSettings also does
  // this on its own mount, but it only mounts when the settings page is open.)
  useEffect(() => {
    if (!isTauri()) return;
    const prefs = loadPetPreferences();
    if (!prefs.enabled || !prefs.petId) return;
    void loadBuiltinPet(prefs.petId)
      .then((pet) => {
        usePet.getState().loadPet(pet);
        void showPetWindow();
        emit("pet-config-update", { petId: prefs.petId } satisfies PetConfigUpdate).catch(
          () => {},
        );
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
