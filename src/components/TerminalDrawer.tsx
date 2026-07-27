"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { useUI } from "@/lib/store";
import { termBus } from "@/lib/terminal-bus";
import { useT } from "@/lib/i18n";
import { Kbd } from "./primitives";
import { handleTermInput, promptLine } from "@/lib/terminal-shell";
import { openExternal } from "@/lib/open-external";
import { X, Command, LayoutGrid, Terminal as TerminalIcon } from "lucide-react";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { TerminalBlocks } from "./TerminalBlocks";
import { TerminalInput } from "./TerminalInput";
import { blockPromptLine } from "@/lib/terminal-block-shell";

/** Read current token values so xterm follows the active theme. */
function buildXtermTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--bg-sunken") || "#0a0a0a",
    foreground: v("--text-primary") || "#eee",
    cursor: v("--accent") || "#0a84ff",
    cursorAccent: v("--bg-sunken") || "#0a0a0a",
    selectionBackground: v("--accent-muted") || "rgba(10,132,255,0.18)",
    green: v("--success") || "#34c759",
    red: v("--danger") || "#ff3b30",
    blue: v("--accent") || "#0a84ff",
    magenta: v("--agent-thinking") || "#bf5af2",
    yellow: v("--warning") || "#ff9500",
  };
}

/** Bottom drawer terminal — slides up with a spring, themed by tokens. */
export function TerminalDrawer() {
  const { terminalOpen, setTerminalOpen } = useUI();
  const { viewMode, setViewMode } = useTerminalBlocks();
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const firstOpenRef = useRef(true);

  /* create the terminal once the drawer first opens (or switches to classic) */
  useEffect(() => {
    if (!terminalOpen || viewMode !== "classic" || !hostRef.current) return;
    let disposed = false;
    let unsub: (() => void) | undefined;
    let observer: MutationObserver | undefined;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebglAddon }, { Unicode11Addon }, { WebLinksAddon }, { SearchAddon }] =
        await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
          import("@xterm/addon-webgl"),
          import("@xterm/addon-unicode11"),
          import("@xterm/addon-web-links"),
          import("@xterm/addon-search"),
        ]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        fontFamily:
          '"SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 1.5,
        cursorBlink: true,
        theme: buildXtermTheme(),
        scrollback: 2000,
      });
      const fit = new FitAddon();
      const webgl = new WebglAddon();
      const unicode11 = new Unicode11Addon();
      const webLinks = new WebLinksAddon((_, uri) => openExternal(uri));
      const search = new SearchAddon();

      term.loadAddon(fit);
      term.loadAddon(unicode11);
      term.unicode.activeVersion = "11"; // enable unicode11 width tables
      term.loadAddon(webLinks);
      term.loadAddon(search);

      term.open(hostRef.current);

      // webgl must load after open(); fallback to canvas on error
      try {
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch (e) {
        console.warn("WebGL renderer unavailable, using canvas:", e);
      }

      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      unsub = termBus.subscribe((data) => term.write(data));

      // interactive shell: keys → line discipline → pi bash RPC (classic mode only)
      term.onData(handleTermInput);
      if (firstOpenRef.current) {
        firstOpenRef.current = false;
        if (viewMode === "classic") {
          promptLine();
        } else {
          blockPromptLine();
        }
      }
      if (viewMode === "classic") term.focus();

      /* follow theme switches */
      observer = new MutationObserver(() => {
        term.options.theme = buildXtermTheme();
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    })();

    return () => {
      disposed = true;
      unsub?.();
      observer?.disconnect();
      webglRef.current?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalOpen, viewMode]);

  /* refit on window resize while open */
  useEffect(() => {
    if (!terminalOpen) return;
    const onResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [terminalOpen]);

  return (
    <AnimatePresence>
      {terminalOpen && (
        <motion.section
          key="terminal"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 240, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 32 }}
          onAnimationComplete={() => fitRef.current?.fit()}
          style={{
            overflow: "hidden",
            flexShrink: 0,
            borderTop: "1px solid var(--separator)",
            background: "var(--bg-sunken)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* drawer header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 16px 6px",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--text-tertiary)",
              }}
            >
              {t("terminal.title")}
            </span>
            <Kbd style={{ fontSize: 10, background: "transparent", border: "none" }}>
              <Command size={10} />J
            </Kbd>

            {/* View mode toggle */}
            <div
              style={{
                marginLeft: "auto",
                display: "flex",
                gap: 4,
                padding: 2,
                background: "var(--bg-base)",
                borderRadius: 6,
                border: "1px solid var(--separator)",
              }}
            >
              <button
                onClick={() => setViewMode("blocks")}
                aria-label="Block view"
                style={{
                  border: "none",
                  background: viewMode === "blocks" ? "var(--accent-muted)" : "transparent",
                  color: viewMode === "blocks" ? "var(--accent)" : "var(--text-tertiary)",
                  cursor: "pointer",
                  padding: "4px 8px",
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 500,
                  transition: "all 0.15s ease",
                }}
              >
                <LayoutGrid size={12} />
                Blocks
              </button>
              <button
                onClick={() => setViewMode("classic")}
                aria-label="Classic view"
                style={{
                  border: "none",
                  background: viewMode === "classic" ? "var(--accent-muted)" : "transparent",
                  color: viewMode === "classic" ? "var(--accent)" : "var(--text-tertiary)",
                  cursor: "pointer",
                  padding: "4px 8px",
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 11,
                  fontWeight: 500,
                  transition: "all 0.15s ease",
                }}
              >
                <TerminalIcon size={12} />
                Classic
              </button>
            </div>

            <button
              onClick={() => setTerminalOpen(false)}
              aria-label={t("terminal.close")}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--text-tertiary)",
                cursor: "pointer",
                fontSize: 13,
                padding: "2px 6px",
                borderRadius: 6,
              }}
            >
              <X size={13} />
            </button>
          </div>

          {/* Content area: blocks view or classic xterm */}
          {viewMode === "blocks" ? (
            <TerminalBlocks />
          ) : (
            <div
              ref={hostRef}
              style={{ flex: 1, minHeight: 0, padding: "0 12px 8px 16px" }}
            />
          )}

          {/* Input row (blocks mode only) */}
          {viewMode === "blocks" && <TerminalInput />}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
