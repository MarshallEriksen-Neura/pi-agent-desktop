"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import {
  Sparkles,
  Boxes,
  Puzzle,
  Wand2,
  Settings,
  Plug,
} from "lucide-react";
import { useUI } from "@/lib/store";
import { usePi } from "@/lib/pi/store";
import { useSessions } from "@/lib/pi/sessions";
import { useT, type MsgKey } from "@/lib/i18n";
import { PiMark } from "@/components/PiMark";

// "Plugins" covers browsing for packages as well as managing installed ones —
// /store/ redirects here rather than holding a rail slot of its own.
const ITEMS: { href: string; icon: React.ReactNode; labelKey: MsgKey }[] = [
  { href: "/", icon: <Sparkles size={17} />, labelKey: "nav.workspace" },
  { href: "/models/", icon: <Boxes size={17} />, labelKey: "nav.models" },
  { href: "/plugins/", icon: <Puzzle size={17} />, labelKey: "nav.plugins" },
  { href: "/skills/", icon: <Wand2 size={17} />, labelKey: "nav.skills" },
  { href: "/mcp/", icon: <Plug size={17} />, labelKey: "nav.mcp" },
  { href: "/settings/", icon: <Settings size={17} />, labelKey: "nav.settings" },
];

const STATUS_COLOR: Record<string, string> = {
  ready: "var(--success)",
  running: "var(--agent-thinking)",
  connecting: "var(--warning)",
  disconnected: "var(--text-tertiary)",
};

/** Left-most icon rail — iPadOS tab-bar feel. Hidden in zen mode. */
export function NavRail() {
  const pathname = usePathname();
  const zenMode = useUI((s) => s.zenMode);
  const status = usePi((s) => s.status);
  const remoteMode = useSessions((s) => s.executionBinding.kind === "ssh");
  const t = useT();
  const visibleItems = remoteMode
    ? ITEMS.filter((item) =>
        item.href === "/" ||
        item.href === "/settings/" ||
        item.href === "/plugins/" ||
        item.href === "/skills/"
      )
    : ITEMS;

  if (zenMode) return null;

  // usePathname() is typed as string but resolves to null before the App Router
  // client has mounted — which is what a hard load of a subroute does (reloading
  // while on /mcp/, or opening it directly). Dereferencing it there threw inside
  // render and took the entire shell down to GlobalErrorBoundary; no tab is
  // active for one paint instead.
  const isActive = (href: string) => {
    if (!pathname) return false;
    return href === "/"
      ? pathname === "/"
      : pathname.startsWith(href.replace(/\/$/, ""));
  };

  return (
    <nav
      className="material-thin"
      style={{
        width: 56,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        paddingTop: 52, // below traffic lights
        paddingBottom: 14,
        borderRight: "1px solid var(--separator)",
        flexShrink: 0,
        zIndex: 15,
      }}
      data-tauri-drag-region
    >
      <PiMark size={30} withBackground style={{ marginBottom: 8 }} />
      {visibleItems.map((item) => {
        const active = isActive(item.href);
        return (
          <Link key={item.href} href={item.href} title={t(item.labelKey)}>
            <motion.span
              whileTap={{ scale: 0.86 }}
              transition={{ type: "spring", stiffness: 500, damping: 24 }}
              style={{
                position: "relative",
                display: "grid",
                placeItems: "center",
                width: 38,
                height: 38,
                fontSize: 16,
                borderRadius: 11, // squircle-ish
                color: active ? "var(--accent)" : "var(--text-tertiary)",
                transition:
                  "color var(--duration-fast) var(--spring-smooth)",
                cursor: "pointer",
              }}
            >
              {/* active pill slides between tabs — iPadOS tab-bar feel */}
              {active && (
                <motion.span
                  layoutId="rail-active"
                  transition={{ type: "spring", stiffness: 500, damping: 34 }}
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: 11,
                    background: "var(--accent-muted)",
                  }}
                />
              )}
              <span
                style={{
                  position: "relative",
                  zIndex: 1,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                {item.icon}
              </span>
            </motion.span>
          </Link>
        );
      })}

      {/* connection dot pinned to the bottom */}
      <span
        title={t("nav.piStatus", { status: t(`status.${status}`) })}
        style={{
          marginTop: "auto",
          width: 8,
          height: 8,
          borderRadius: 99,
          background: STATUS_COLOR[status] ?? "var(--text-tertiary)",
          boxShadow:
            status === "running" ? "0 0 0 4px var(--accent-muted)" : "none",
        }}
      />
    </nav>
  );
}
