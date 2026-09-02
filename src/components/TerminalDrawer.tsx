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
import {
  APP_MIN_HEIGHT_BESIDE_TERMINAL,
  TERMINAL_HEIGHT_MAX,
  TERMINAL_HEIGHT_MIN,
  useUI,
} from "@/lib/store";
import { PanelResizer } from "./PanelResizer";
import { isMacPlatform } from "@/lib/shortcuts";
import { ansi, termBus } from "@/lib/terminal-bus";
import { useT } from "@/lib/i18n";
import { Kbd } from "./primitives";
import { handleTermInput, currentTerminalLine, pasteIntoTerminal, promptLine } from "@/lib/terminal-shell";
import { openExternal } from "@/lib/open-external";
import { X, Command, FileDown, LayoutGrid, Terminal as TerminalIcon } from "lucide-react";
import { formatDroppedPaths } from "@/lib/terminal-drop";
import { useFileDropZone } from "@/lib/use-file-drop";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { TerminalBlocks } from "./TerminalBlocks";
import { TerminalInput } from "./TerminalInput";
import { runPastedLines } from "@/lib/terminal-block-shell";
import { useSessions } from "@/lib/pi/sessions";
import { getPort } from "@/lib/backend/composition/container";
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

let remoteTerminalSequence = 0;
function nextRemoteTerminalSessionId(): string {
  remoteTerminalSequence += 1;
  return `terminal_${Date.now().toString(36)}_${remoteTerminalSequence.toString(36)}`;
}

/** Bottom drawer terminal — slides up with a spring, themed by tokens. */
export function TerminalDrawer() {
  const {
    terminalOpen,
    setTerminalOpen,
    terminalHeight,
    terminalResizing,
    setTerminalHeight,
    persistTerminalHeight,
    setTerminalResizing,
    resetTerminalHeight,
  } = useUI();
  const { viewMode, setViewMode } = useTerminalBlocks();
  const executionBinding = useSessions((state) => state.executionBinding);
  const remoteBinding = executionBinding.kind === "ssh" ? executionBinding : null;
  const remoteBindingRef = useRef(remoteBinding);
  remoteBindingRef.current = remoteBinding;
  const effectiveViewMode = remoteBinding ? "classic" : viewMode;
  const terminalTargetKey = remoteBinding
    ? `${remoteBinding.profileId}:${remoteBinding.profileRevision}:${remoteBinding.remoteCwd}`
    : "local";
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

  /** Whether the classic xterm view is the one on screen. */
  const isClassicView = useCallback(
    () =>
      remoteBindingRef.current !== null ||
      useTerminalBlocks.getState().viewMode === "classic",
    []
  );

  /** Insert text into whichever view is showing: the xterm line, or the input box. */
  const insertText = useCallback(
    (text: string) => {
      if (!text) return;
      if (isClassicView()) {
        if (remoteBindingRef.current) termRef.current?.paste(text);
        else pasteIntoTerminal(text);
        return;
      }
      const store = useTerminalBlocks.getState();
      // Complete lines run; the tail joins whatever is already in the input.
      const tail = runPastedLines(store.input + text);
      useTerminalBlocks.getState().setInput(tail);
    },
    [isClassicView]
  );

  /** Paste into whichever view is showing: the xterm line, or the input box. */
  const pasteFromClipboard = useCallback(async () => {
    const text = await readClipboardText();
    if (!text) {
      const message = ansi.dim(tRef.current("terminal.clipboardUnavailable"));
      if (remoteBindingRef.current) termRef.current?.writeln(message);
      else if (isClassicView()) termBus.writeln(message);
      return;
    }
    insertText(text);
  }, [insertText, isClassicView]);

  /**
   * Type the paths of files dropped onto the drawer.
   *
   * A drop types, it never runs: `formatDroppedPaths` emits no newline, so the
   * paths land as an editable argument list in either view.
   */
  const insertDroppedPaths = useCallback(
    (paths: string[]) => {
      const remote = remoteBindingRef.current !== null;
      const text = formatDroppedPaths(paths, {
        precedingLine: remote
          ? null
          : isClassicView()
            ? currentTerminalLine()
            : useTerminalBlocks.getState().input,
      });
      insertText(text);
      // The drag started in another application, so the terminal is very likely
      // not the focused element by the time the path lands in it.
      if (isClassicView()) termRef.current?.focus();
    },
    [insertText, isClassicView]
  );

  const dropZoneRef = useRef<HTMLElement>(null);
  const dropActive = useFileDropZone({
    enabled: terminalOpen,
    targetRef: dropZoneRef,
    onDrop: insertDroppedPaths,
  });

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

  /* create the terminal once the drawer first opens (or switches targets) */
  useEffect(() => {
    if (!terminalOpen || effectiveViewMode !== "classic" || !hostRef.current) return;
    let disposed = false;
    let unsub: (() => void) | undefined;
    let remoteUnlisteners: Array<() => void> = [];
    let remoteSessionId: string | null = null;
    let observer: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const host = hostRef.current;
    const binding = remoteBinding;
    const remotePort = binding ? getPort("remoteTerminal") : null;

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
      term.unicode.activeVersion = "11";
      term.loadAddon(webLinks);
      term.loadAddon(search);

      /* Clipboard bindings are owned by the embedder; xterm intentionally has none. */
      const isMac = isMacPlatform();
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (!mod || e.altKey) return true;
        const key = e.key.toLowerCase();

        if (key === "c") {
          if (!e.shiftKey && !term.hasSelection()) return true;
          const selection = term.getSelection();
          e.preventDefault();
          if (!selection) return false;
          void copyText(selection);
          term.clearSelection();
          return false;
        }

        if (key === "v") {
          if (e.shiftKey) {
            e.preventDefault();
            void pasteFromClipboard();
            return false;
          }
          armPasteFallback();
          return true;
        }

        return true;
      });

      term.open(hostRef.current);
      const tryWebgl = () => {
        try {
          term.loadAddon(webgl);
          webglRef.current = webgl;
        } catch (error) {
          console.warn("WebGL renderer unavailable, using canvas:", error);
        }
      };

      fit.fit();
      tryWebgl();
      termRef.current = term;
      fitRef.current = fit;

      if (binding && remotePort) {
        remoteSessionId = nextRemoteTerminalSessionId();
        const sessionId = remoteSessionId;
        const stopRemoteSession = () =>
          remotePort.stop(sessionId).catch(() => undefined);
        const disposeRemoteListeners = () => {
          remoteUnlisteners.forEach((unlisten) => unlisten());
          remoteUnlisteners = [];
        };
        let startRequested = false;
        let remoteStarted = false;
        let remoteExited = false;
        let acceptingInput = true;
        let writeFailed = false;
        let pendingInput: string[] = [];
        let pendingInputBytes = 0;
        let latestSize = {
          cols: Math.max(1, term.cols),
          rows: Math.max(1, term.rows),
        };
        const reportWriteFailure = (error: unknown) => {
          if (disposed || writeFailed) return;
          writeFailed = true;
          acceptingInput = false;
          pendingInput = [];
          pendingInputBytes = 0;
          term.write(
            `\r\n${ansi.dim(tRef.current("terminal.remoteWriteFailed", { error: String(error) }))}\r\n`
          );
        };
        const writeRemoteInput = (data: string) => {
          void remotePort.write(sessionId, data).catch(reportWriteFailure);
        };
        term.onData((data) => {
          if (disposed || !acceptingInput || remoteExited) return;
          if (remoteStarted) {
            writeRemoteInput(data);
            return;
          }
          // Keep startup input bounded to the backend's single-write limit. Four
          // bytes per UTF-16 code unit is a conservative UTF-8 upper bound.
          const estimatedBytes = data.length * 4;
          if (pendingInputBytes + estimatedBytes > 256 * 1024) {
            reportWriteFailure(tRef.current("terminal.remoteInputOverflow"));
            return;
          }
          pendingInput.push(data);
          pendingInputBytes += estimatedBytes;
        });
        term.onResize(({ cols, rows }) => {
          latestSize = { cols: Math.max(1, cols), rows: Math.max(1, rows) };
          if (!remoteStarted || disposed || remoteExited) return;
          void remotePort
            .resize(sessionId, latestSize.cols, latestSize.rows)
            .catch(() => undefined);
        });
        term.write(
          `${ansi.dim(tRef.current("terminal.remoteConnecting", { host: binding.hostAlias }))}\r\n`
        );
        try {
          remoteUnlisteners.push(
            await remotePort.onData((event) => {
              if (!disposed && event.sessionId === sessionId) term.write(event.data);
            })
          );
          if (disposed) {
            acceptingInput = false;
            pendingInput = [];
            disposeRemoteListeners();
            return;
          }
          remoteUnlisteners.push(
            await remotePort.onExit((event) => {
              if (disposed || event.sessionId !== sessionId) return;
              remoteExited = true;
              remoteStarted = false;
              acceptingInput = false;
              pendingInput = [];
              pendingInputBytes = 0;
              const detail = event.error ?? event.signal ?? String(event.code ?? "?");
              term.write(
                `\r\n${ansi.dim(tRef.current("terminal.remoteExited", { detail }))}\r\n`
              );
            })
          );
          if (disposed) {
            acceptingInput = false;
            pendingInput = [];
            disposeRemoteListeners();
            return;
          }
          startRequested = true;
          await remotePort.start({
            sessionId,
            executionBinding: binding,
            cols: latestSize.cols,
            rows: latestSize.rows,
          });
          if (disposed) {
            acceptingInput = false;
            pendingInput = [];
            void stopRemoteSession();
            return;
          }
          if (remoteExited) return;

          // Startup can span a drawer animation. Fit once more so the PTY receives
          // the final host dimensions even if ResizeObserver has not fired yet.
          try {
            fit.fit();
          } catch {
            /* host may briefly report 0 during animations */
          }
          remoteStarted = true;
          void remotePort
            .resize(sessionId, latestSize.cols, latestSize.rows)
            .catch(() => undefined);
          const queuedInput = pendingInput;
          pendingInput = [];
          pendingInputBytes = 0;
          queuedInput.forEach(writeRemoteInput);
        } catch (error) {
          acceptingInput = false;
          pendingInput = [];
          pendingInputBytes = 0;
          disposeRemoteListeners();
          if (startRequested) void stopRemoteSession();
          if (!disposed) {
            term.write(
              `${ansi.dim(tRef.current("terminal.remoteStartFailed", { error: String(error) }))}\r\n`
            );
          }
        }
      } else {
        unsub = termBus.subscribe((data) => term.write(data));
        term.onData(handleTermInput);
        if (firstOpenRef.current) {
          firstOpenRef.current = false;
          promptLine();
        }
      }
      focusTerm();

      resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* host may briefly report 0 during animations */
        }
      });
      resizeObserver.observe(hostRef.current);

      observer = new MutationObserver(() => {
        term.options.theme = buildXtermTheme();
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
    })();

    host.addEventListener("mousedown", onHostMouseDown);
    host.addEventListener("paste", disarmPasteFallback);

    return () => {
      disposed = true;
      unsub?.();
      remoteUnlisteners.forEach((unlisten) => unlisten());
      if (remotePort && remoteSessionId) {
        void remotePort.stop(remoteSessionId).catch(() => undefined);
      }
      observer?.disconnect();
      resizeObserver?.disconnect();
      host.removeEventListener("mousedown", onHostMouseDown);
      host.removeEventListener("paste", disarmPasteFallback);
      disarmPasteFallback();
      webglRef.current?.dispose();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      webglRef.current = null;
    };
    // terminalTargetKey deliberately restarts the SSH child when host, revision, or cwd changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalOpen, effectiveViewMode, terminalTargetKey]);

  /**
   * On a window resize, refit xterm and re-measure the viewport.
   *
   * Both belong to the same event: the drawer shares the window's height with
   * the chat and the editor, so unlike the side columns its ceiling is not a
   * constant — a height that was reasonable on a maximised window would swallow
   * the conversation on a small one, and shrinking the window has to pull the
   * drawer back down with it.
   */
  const [viewportHeight, setViewportHeight] = useState(0);
  useEffect(() => {
    if (!terminalOpen) return;
    const onResize = () => {
      setViewportHeight(window.innerHeight);
      fitRef.current?.fit();
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [terminalOpen]);

  const terminalBounds = useCallback(() => {
    const room = viewportHeight
      ? viewportHeight - APP_MIN_HEIGHT_BESIDE_TERMINAL
      : TERMINAL_HEIGHT_MAX;
    return {
      min: TERMINAL_HEIGHT_MIN,
      // Clamp up rather than inverting the range: on a very short window the
      // floor wins and the drawer stays usable.
      max: Math.max(TERMINAL_HEIGHT_MIN, Math.min(TERMINAL_HEIGHT_MAX, room)),
    };
  }, [viewportHeight]);

  /** What the drawer is actually drawn at, capped against the window right now. */
  const effectiveHeight = Math.min(terminalHeight, terminalBounds().max);

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
      const classic = effectiveViewMode === "classic";
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
        onSelect: () => {
          if (remoteBindingRef.current) {
            term?.clear();
            term?.write("\x1b[3J\x1b[2J\x1b[H");
          } else {
            clearTerminalView();
          }
        },
      });

      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [effectiveViewMode, t, pasteFromClipboard]
  );

  return (
    <AnimatePresence>
      {terminalOpen && (
        <motion.section
          key="terminal"
          ref={dropZoneRef}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: effectiveHeight, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          /* The spring is right for open/close but wrong for a drag — it would
             trail the pointer, and xterm would refit against a stale height. */
          transition={
            terminalResizing
              ? { duration: 0 }
              : { type: "spring", stiffness: 300, damping: 32 }
          }
          onAnimationComplete={() => fitRef.current?.fit()}
          style={{
            overflow: "hidden",
            flexShrink: 0,
            borderTop: "1px solid var(--separator)",
            background: "var(--bg-sunken)",
            display: "flex",
            flexDirection: "column",
            // anchors the drop overlay below
            position: "relative",
          }}
        >
          {/* Drag the top seam to resize. Mounted first so it sits above the
              header's padding rather than under the row's controls. */}
          <PanelResizer
            edge="top"
            width={effectiveHeight}
            bounds={terminalBounds}
            onResize={setTerminalHeight}
            onResizeStateChange={setTerminalResizing}
            onCommit={persistTerminalHeight}
            onReset={resetTerminalHeight}
            label={t("terminal.resize")}
          />

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
            {remoteBinding && (
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
                SSH · {remoteBinding.hostAlias}
              </span>
            )}
            <Kbd style={{ fontSize: 10, background: "transparent", border: "none" }}>
              <Command size={10} />J
            </Kbd>

            {/* View mode toggle: remote PTYs always use the classic xterm view. */}
            {!remoteBinding && (
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
                aria-label={t("terminal.blockView")}
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
                {t("terminal.blocks")}
              </button>
              <button
                onClick={() => setViewMode("classic")}
                aria-label={t("terminal.classicView")}
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
                {t("terminal.classic")}
              </button>
            </div>
            )}

            <button
              onClick={() => setTerminalOpen(false)}
              aria-label={t("terminal.close")}
              style={{
                marginLeft: remoteBinding ? "auto" : undefined,
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
            {effectiveViewMode === "blocks" ? (
              <TerminalBlocks />
            ) : (
              <div
                ref={hostRef}
                style={{ flex: 1, minHeight: 0, padding: "0 12px 8px 16px" }}
              />
            )}
          </div>

          {/* Input row (blocks mode only) */}
          {effectiveViewMode === "blocks" && <TerminalInput />}

          {/*
            Drop affordance. Purely visual — the drop itself is delivered by the
            OS to the window, so this cannot be a `dragover` target and must not
            take pointer events away from the terminal underneath it.
          */}
          {dropActive && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 6,
                zIndex: 5,
                borderRadius: 8,
                border: "1.5px dashed var(--accent)",
                background: "var(--accent-muted)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                fontSize: 12,
                fontWeight: 500,
                color: "var(--accent)",
                pointerEvents: "none",
              }}
            >
              <FileDown size={13} />
              {t("terminal.dropHint")}
            </div>
          )}

          {menu && (
            <TerminalContextMenu state={menu} onClose={() => setMenu(null)} />
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
