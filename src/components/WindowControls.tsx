"use client";

import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { isTauri } from "@/lib/pi/client";
import { useT } from "@/lib/i18n";
import { requestClose } from "@/lib/window-close";

/**
 * Windows/Linux caption buttons (minimize / maximize / close) for the
 * frameless Tauri window. Hidden on macOS, where the native traffic
 * lights are shown via `titleBarStyle: "Overlay"`.
 */
export function WindowControls() {
  const [visible, setVisible] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const t = useT();

  useEffect(() => {
    if (!isTauri() || navigator.userAgent.includes("Mac")) return;
    setVisible(true);

    let unlisten: (() => void) | undefined;
    let disposed = false;

    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const sync = async () => setMaximized(await win.isMaximized());
      await sync();
      const off = await win.onResized(sync);
      if (disposed) off();
      else unlisten = off;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!visible) return null;

  const act = async (action: "minimize" | "toggleMaximize" | "close") => {
    if (action === "close") {
      // route through the user's close behavior (ask / minimize / quit)
      requestClose();
      return;
    }
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()[action]();
  };

  return (
    <div
      style={{
        display: "flex",
        alignSelf: "stretch",
        marginLeft: 4,
        marginRight: -12, // flush against the window edge past the header padding
      }}
    >
      <CaptionButton label={t("topbar.minimize")} onClick={() => act("minimize")}>
        <Minus size={15} strokeWidth={1.5} />
      </CaptionButton>
      <CaptionButton
        label={maximized ? t("topbar.restore") : t("topbar.maximize")}
        onClick={() => act("toggleMaximize")}
      >
        {maximized ? (
          <Copy size={13} strokeWidth={1.5} style={{ transform: "scaleX(-1)" }} />
        ) : (
          <Square size={12.5} strokeWidth={1.5} />
        )}
      </CaptionButton>
      <CaptionButton label={t("topbar.close")} onClick={() => act("close")} danger>
        <X size={15} strokeWidth={1.5} />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  children,
  label,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        placeItems: "center",
        width: 44,
        height: "100%",
        border: "none",
        borderRadius: 0,
        cursor: "default",
        color: hover && danger ? "#fff" : "var(--text-secondary)",
        background: hover
          ? danger
            ? "#e81123"
            : "var(--bg-sunken)"
          : "transparent",
        transition: "background var(--duration-fast) var(--spring-smooth)",
      }}
    >
      {children}
    </button>
  );
}
