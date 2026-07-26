"use client";

import { useEffect } from "react";
import { TooltipProvider } from "@appica/ui-react/tooltip";
import { NavRail } from "./NavRail";
import { ExtensionSheet } from "./ExtensionSheet";
import { SubagentDetail } from "./Subagents";
import { usePi } from "@/lib/pi/store";
import { useChat } from "@/lib/pi/chat";
import { useSessions } from "@/lib/pi/sessions";
import { useExtUi } from "@/lib/pi/ext-ui";
import { useSubagents } from "@/lib/pi/subagents";
import { initAgentBridge } from "@/lib/pi/agent-bridge";
import { useWorkspace } from "@/lib/workspace";
import { useI18n } from "@/lib/i18n";
import { useAppearance } from "@/lib/appearance";

/** Root chrome: nav rail + page content. Connects to pi on mount. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const connect = usePi((s) => s.connect);

  useEffect(() => {
    // restore the saved UI language (or detect from the system) before first paint settles
    useI18n.getState().initLocale();
    // restore user-customized appearance (colors, background, text scale)
    useAppearance.getState().init();
    // subscribe before connecting so no early events are missed
    useChat.getState().init();
    useExtUi.getState().init();
    useSubagents.getState().initPiBridge();
    initAgentBridge(); // tool events → task strip / editor highlights / terminal
    // resolve the project root first so pi spawns inside it
    void useWorkspace
      .getState()
      .init()
      .then(() => connect({ cwd: useWorkspace.getState().root ?? undefined }))
      // session history restores after connect so pi can switch to the stored file
      .then(() => useSessions.getState().init());

    // Esc collapses the subagent detail back into its card
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useSubagents.getState().focusedId) {
        e.stopPropagation();
        useSubagents.getState().focus(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [connect]);

  return (
    <TooltipProvider delay={400}>
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
        <NavRail />
        <div style={{ flex: 1, minWidth: 0, height: "100%" }}>{children}</div>
        <ExtensionSheet />
        <SubagentDetail />
      </div>
    </TooltipProvider>
  );
}
