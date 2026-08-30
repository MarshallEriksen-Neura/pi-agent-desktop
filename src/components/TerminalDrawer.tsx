"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { useUI } from "@/lib/store";
import { isMacPlatform } from "@/lib/shortcuts";
import { ansi, termBus } from "@/lib/terminal-bus";
import { useT } from "@/lib/i18n";
import { Kbd } from "./primitives";
import { handleTermInput, pasteIntoTerminal, promptLine } from "@/lib/terminal-shell";
import { openExternal } from "@/lib/open-external";
import { X, Command, LayoutGrid, Terminal as TerminalIcon } from "lucide-react";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { TerminalBlocks } from "./TerminalBlocks";
import { TerminalInput } from "./TerminalInput";
import { blockPromptLine, runPastedLines } from "@/lib/terminal-block-shell";
import { useRuntime } from "@/lib/pi/runtime";
import {
  canReadClipboard,
  copyText,
  readClipboardText,
} from "@/lib/terminal-clipboard";
import { clearTerminalView } from "@/lib/terminal-builtins";
import {
  TerminalContextMenu,
  type TerminalMenuItem,
  type TerminalMenuState,
} from "./TerminalContextMenu";

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

/**
 * The app's mono stack, read from the stylesheet.
 *
 * xterm draws to a canvas, so it needs a literal family string rather than a CSS
 * variable — and a second copy of the list is a copy that drifts. This one asks
 * the document for the same `--font-mono` the editor and every diff gutter use,
 * so the terminal cannot end up on a different face (or on a ligature cut, which
 * a fixed cell grid does not want) than the rest of the app.
 */
function monoFontStack(): string {
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    // the declaration wraps across lines; canvas measurement wants one line
    .replace(/\s+/g, " ")
    .trim();
  return declared || "ui-monospace, Consolas, monospace";
}

/** Bottom drawer terminal — slides up with a spring, themed by tokens. */
export function TerminalDrawer() {
  const { terminalOpen, setTerminalOpen } = useUI();
  const { viewMode, setViewMode } = useTerminalBlocks();
  const runtime = useRuntime((state) => state.persistedConfig);
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
  const firstOpenRef = useRef(true);
  const [menu, setMenu] = useState<TerminalMenuState | null>(null);
  // The terminal is built once per open; `t` changes whenever the locale does.
  // A ref keeps the key handler's messages current without tearing the terminal
  // down and rebuilding it on a language switch.
  const tRef = useRef(t);
  tRef.current = t;

  /**
   * Set when Ctrl/Cmd+V was seen and it is not yet known whether the webview
   * will deliver a native `paste` event for it.
   */
  const pasteArmedRef = useRef<number | null>(null);

  /** Paste into whichever view is showing: the xterm line, or the input box. */
  const pasteFromClipboard = useCallback(async () => {
    const text = await readClipboardText();
    if (!text) {
      if (useTerminalBlocks.getState().viewMode === "classic") {
        termBus.writeln(ansi.dim(tRef.current("terminal.clipboardUnavailable")));
      }
      return;
    }
    if (useTerminalBlocks.getState().viewMode === "classic") {
      pasteIntoTerminal(text);
      return;
    }
    const store = useTerminalBlocks.getState();
    // Complete lines run; the tail joins whatever is already in the input.
    const tail = runPastedLines(store.input + text);
    useTerminalBlocks.getState().setInput(tail);
  }, []);

  /**
   * Watch for a native `paste` event after Ctrl/Cmd+V, and read the clipboard
   * ourselves only if none arrives.
   *
   * Written as a race rather than a platform check because the two ways a paste
   * can reach a webview terminal fail on opposite axes: the native event needs no
   * permission but is not delivered everywhere, and the clipboard read is
   * delivered everywhere but can be denied. Whichever one works, one paste
   * happens — the timer is cancelled by the event, so they cannot both fire.
   */
  const armPasteFallback = useCallback(() => {
    if (pasteArmedRef.current !== null) window.clearTimeout(pasteArmedRef.current);
    pasteArmedRef.current = window.setTimeout(() => {
      pasteArmedRef.current = null;
      void pasteFromClipboard();
    }, 150);
  }, [pasteFromClipboard]);

  const disarmPasteFallback = useCallback(() => {
    if (pasteArmedRef.current === null) return;
    window.clearTimeout(pasteArmedRef.current);
    pasteArmedRef.current = null;
  }, []);

  /* create the terminal once the drawer first opens (or switches to classic) */
  useEffect(() => {
    if (!terminalOpen || viewMode !== "classic" || !hostRef.current) return;
    let disposed = false;
    let unsub: (() => void) | undefined;
    let observer: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const host = hostRef.current;

    const focusTerm = () => {
      // xterm's hidden textarea can lose focus between mount and first paint,
      // or after a parent re-render — request focus again on a microtask and
      // also on the next frame so it survives late layout work.
      termRef.current?.focus();
      queueMicrotask(() => termRef.current?.focus());
      requestAnimationFrame(() => termRef.current?.focus());
    };

    const onHostMouseDown = () => focusTerm();

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
        allowProposedApi: true,
        fontFamily: monoFontStack(),
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

      /*
       * Clipboard bindings. xterm deliberately ships none — Ctrl-C is the
       * shell's interrupt and the embedder decides what else the modifier does.
       *
       * Returning false stops xterm from turning the key into shell input, but
       * it does *not* stop the browser: xterm consults this handler before it
       * would call preventDefault. So anything handled here has to cancel the
       * event itself, or a paste lands twice — once from the clipboard read and
       * again from the native `paste` event xterm also listens for.
       */
      const isMac = isMacPlatform();
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (!mod || e.altKey) return true;
        const key = e.key.toLowerCase();

        if (key === "c") {
          // Ctrl/Cmd+Shift+C always copies. Plain Ctrl-C copies only with a
          // selection, the way Windows Terminal does it, so an unselected
          // Ctrl-C still reaches the shell as SIGINT. On macOS Cmd-C copies and
          // Ctrl-C interrupts, which `mod` already separates.
          if (!e.shiftKey && !term.hasSelection()) return true;
          const selection = term.getSelection();
          e.preventDefault();
          if (!selection) return false;
          void copyText(selection);
          // Clear it so the next Ctrl-C interrupts instead of copying again —
          // otherwise a stale selection makes the command unkillable.
          term.clearSelection();
          return false;
        }

        if (key === "v") {
          if (e.shiftKey) {
            // Ctrl/Cmd+Shift+V is the explicit route: no native paste event is
            // coming, so reading the clipboard is the only way to serve it.
            e.preventDefault();
            void pasteFromClipboard();
            return false;
          }
          // Plain Ctrl/Cmd+V deliberately does NOT preventDefault. The webview's
          // own paste event costs no permission, and cancelling it to read the
          // clipboard instead would put a prompt in front of the first paste —
          // where a single "Block" is remembered by the webview and would leave
          // this binding permanently dead.
          //
          // The native event is expected on all three platforms (the app sets
          // its menu on the tray, not the app, so Tauri still installs the
          // default macOS menu and its Edit→Paste accelerator). armPasteFallback
          // is insurance, not a platform workaround: if the event ever does not
          // arrive, the terminal would otherwise have no paste at all, and the
          // guard costs one cancelled timer when it does.
          armPasteFallback();
          return true;
        }

        return true;
      });

      term.open(hostRef.current);

      // webgl must load after open(); fallback to canvas on error.
      // Load asynchronously and after the first fit so its canvas init
      // doesn't race with the resize that establishes the textarea layout.
      const tryWebgl = () => {
        try {
          term.loadAddon(webgl);
          webglRef.current = webgl;
        } catch (e) {
          console.warn("WebGL renderer unavailable, using canvas:", e);
        }
      };

      fit.fit();
      tryWebgl();

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
      focusTerm();

      // keep the terminal sized as the drawer / host changes layout
      resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* host may briefly report 0 during animations */
        }
      });
      resizeObserver.observe(hostRef.current);

      /* follow theme switches */
      observer = new MutationObserver(() => {
        term.options.theme = buildXtermTheme();
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    })();

    host.addEventListener("mousedown", onHostMouseDown);
    // A native paste arrived, so the clipboard-read fallback must stand down.
    // xterm binds its own handler to the textarea and to its root element; this
    // listens on the host those live in, so it sees the event either way.
    host.addEventListener("paste", disarmPasteFallback);

    return () => {
      disposed = true;
      unsub?.();
      observer?.disconnect();
      resizeObserver?.disconnect();
      host.removeEventListener("mousedown", onHostMouseDown);
      host.removeEventListener("paste", disarmPasteFallback);
      // a pending fallback must not fire into a terminal that is going away
      disarmPasteFallback();
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

  /**
   * Build the right-click menu against whatever is selected right now.
   *
   * The two views hold a selection in different places: classic mode keeps it in
   * xterm (drawn on a canvas, invisible to the DOM), block mode is ordinary DOM
   * text.
   */
  const openMenu = useCallback(
    (e: React.MouseEvent) => {
      // AppShell already cancels the native menu app-wide; this only stops the
      // event from also reaching a parent that might act on a right-click.
      e.preventDefault();
      const term = termRef.current;
      const classic = viewMode === "classic";
      const selection = classic
        ? (term?.getSelection() ?? "")
        : (window.getSelection()?.toString() ?? "");
      const mod = isMacPlatform() ? "⌘" : "Ctrl";

      const items: TerminalMenuItem[] = [
        {
          label: t("terminal.copy"),
          hint: classic ? `${mod}C` : undefined,
          disabled: !selection,
          onSelect: () => {
            void copyText(selection);
            if (classic) term?.clearSelection();
          },
        },
        {
          label: t("terminal.paste"),
          hint: `${mod}V`,
          disabled: !canReadClipboard(),
          onSelect: () => void pasteFromClipboard(),
        },
      ];
      if (classic) {
        items.push({
          label: t("terminal.selectAll"),
          onSelect: () => term?.selectAll(),
        });
      }
      items.push({
        label: t("terminal.clear"),
        hint: classic ? "Ctrl+L" : undefined,
        onSelect: () => clearTerminalView(),
      });

      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [viewMode, t, pasteFromClipboard]
  );

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
            {runtime.mode === "wsl" && (
              <span
                style={{
                  fontSize: 10.5,
                  color: "var(--success)",
                  border: "1px solid color-mix(in srgb, var(--success) 35%, transparent)",
                  borderRadius: 4,
                  padding: "1px 5px",
                  lineHeight: 1.4,
                }}
              >
                WSL{runtime.distro ? ` · ${runtime.distro}` : ""}
              </span>
            )}
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
          <div
            onContextMenu={openMenu}
            style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
          >
            {viewMode === "blocks" ? (
              <TerminalBlocks />
            ) : (
              <div
                ref={hostRef}
                style={{ flex: 1, minHeight: 0, padding: "0 12px 8px 16px" }}
              />
            )}
          </div>

          {/* Input row (blocks mode only) */}
          {viewMode === "blocks" && <TerminalInput />}

          {menu && (
            <TerminalContextMenu state={menu} onClose={() => setMenu(null)} />
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
