"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useUI } from "@/lib/store";
import { termBus } from "@/lib/terminal-bus";
import { useT } from "@/lib/i18n";
import { Kbd } from "./primitives";
import {
  wireBashEvents,
  handleTermInput,
  promptLine,
} from "@/lib/terminal-shell";
import { X, Command } from "lucide-react";

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
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const firstOpenRef = useRef(true);

  /* create the terminal once the drawer first opens */
  useEffect(() => {
    if (!terminalOpen || termRef.current || !hostRef.current) return;
    let disposed = false;
    let unsub: (() => void) | undefined;
    let observer: MutationObserver | undefined;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
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
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      unsub = termBus.subscribe((data) => term.write(data));

      // interactive shell: keys → line discipline → pi bash RPC
      wireBashEvents();
      term.onData(handleTermInput);
      if (firstOpenRef.current) {
        firstOpenRef.current = false;
        promptLine();
      }
      term.focus();

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
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalOpen]);

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
            <button
              onClick={() => setTerminalOpen(false)}
              aria-label={t("terminal.close")}
              style={{
                marginLeft: "auto",
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

          <div
            ref={hostRef}
            style={{ flex: 1, minHeight: 0, padding: "0 12px 8px 16px" }}
          />
        </motion.section>
      )}
    </AnimatePresence>
  );
}
