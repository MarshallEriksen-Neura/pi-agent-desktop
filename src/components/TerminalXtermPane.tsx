"use client";

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalTab } from "@/lib/terminal-tabs";
import { ansi, termBus } from "@/lib/terminal-bus";
import { handleTermInput, promptLine } from "@/lib/terminal-shell";
import { getBackendKind, getPort } from "@/lib/backend/composition/container";
import type { ExecutionBinding } from "@/lib/backend/ports/execution-target";
import { isMacPlatform } from "@/lib/shortcuts";
import { copyText } from "@/lib/terminal-clipboard";
import { openExternal } from "@/lib/open-external";
import { useT } from "@/lib/i18n";

const LOCAL_EXECUTION_BINDING: ExecutionBinding = { kind: "local", targetId: "local" };

export interface TerminalPaneController {
  terminal: Terminal;
  fit(): void;
}

interface TerminalXtermPaneProps {
  tab: TerminalTab;
  visible: boolean;
  drawerOpen: boolean;
  onReady: (id: string, controller: TerminalPaneController | null) => void;
  onPasteRequest: () => void;
}

function buildXtermTheme() {
  const css = getComputedStyle(document.documentElement);
  const value = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: value("--bg-sunken") || "#0a0a0a",
    foreground: value("--text-primary") || "#eee",
    cursor: value("--accent") || "#0a84ff",
    cursorAccent: value("--bg-sunken") || "#0a0a0a",
    selectionBackground: value("--accent-muted") || "rgba(10,132,255,0.18)",
    green: value("--success") || "#34c759",
    red: value("--danger") || "#ff3b30",
    blue: value("--accent") || "#0a84ff",
    magenta: value("--agent-thinking") || "#bf5af2",
    yellow: value("--warning") || "#ff9500",
  };
}

function monoFontStack(): string {
  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .replace(/\s+/g, " ")
    .trim();
  return declared || "ui-monospace, Consolas, monospace";
}

function startPtyTerminal(
  tab: TerminalTab,
  term: Terminal,
  isDisposed: () => boolean,
  translate: ReturnType<typeof useT>
): () => void {
  const remotePort = getPort("remoteTerminal");
  const sessionId = tab.id;
  let unlisteners: Array<() => void> = [];
  let startRequested = false;
  let remoteStarted = false;
  let remoteExited = false;
  let acceptingInput = true;
  let writeFailed = false;
  let pendingInput: string[] = [];
  let pendingInputBytes = 0;
  let latestSize = { cols: Math.max(1, term.cols), rows: Math.max(1, term.rows) };
  const isSsh = tab.kind === "ssh";
  const localShell = isSsh ? null : tab.shellProfile;
  const inputOverflowKey = isSsh ? "terminal.remoteInputOverflow" : "terminal.localInputOverflow";
  const exitedKey = isSsh ? "terminal.remoteExited" : "terminal.localExited";
  const startFailedKey = isSsh ? "terminal.remoteStartFailed" : "terminal.localStartFailed";

  const disposeListeners = () => {
    unlisteners.forEach((unlisten) => unlisten());
    unlisteners = [];
  };
  const stop = () => remotePort.stop(sessionId).catch(() => undefined);
  const reportWriteFailure = (error: unknown) => {
    if (isDisposed() || writeFailed) return;
    writeFailed = true;
    acceptingInput = false;
    pendingInput = [];
    pendingInputBytes = 0;
    term.write(`\r\n${ansi.dim(translate("terminal.remoteWriteFailed", { error: String(error) }))}\r\n`);
  };
  const write = (data: string) => {
    void remotePort.write(sessionId, data).catch(reportWriteFailure);
  };

  term.onData((data) => {
    if (isDisposed() || !acceptingInput || remoteExited) return;
    if (remoteStarted) {
      write(data);
      return;
    }
    const estimatedBytes = data.length * 4;
    if (pendingInputBytes + estimatedBytes > 256 * 1024) {
      reportWriteFailure(translate(inputOverflowKey));
      return;
    }
    pendingInput.push(data);
    pendingInputBytes += estimatedBytes;
  });
  term.onResize(({ cols, rows }) => {
    latestSize = { cols: Math.max(1, cols), rows: Math.max(1, rows) };
    if (!remoteStarted || isDisposed() || remoteExited) return;
    void remotePort.resize(sessionId, latestSize.cols, latestSize.rows).catch(() => undefined);
  });

  const startingMessage = isSsh
    ? translate("terminal.remoteConnecting", { host: tab.binding.hostAlias })
    : translate("terminal.localStarting");
  term.write(`${ansi.dim(startingMessage)}\r\n`);
  void (async () => {
    try {
      unlisteners.push(
        await remotePort.onData((event) => {
          if (!isDisposed() && event.sessionId === sessionId) term.write(event.data);
        })
      );
      if (isDisposed()) {
        acceptingInput = false;
        pendingInput = [];
        disposeListeners();
        return;
      }
      unlisteners.push(
        await remotePort.onExit((event) => {
          if (isDisposed() || event.sessionId !== sessionId) return;
          remoteExited = true;
          remoteStarted = false;
          acceptingInput = false;
          pendingInput = [];
          pendingInputBytes = 0;
          const detail = event.error ?? event.signal ?? String(event.code ?? "?");
          term.write(`\r\n${ansi.dim(translate(exitedKey, { detail }))}\r\n`);
        })
      );
      if (isDisposed()) {
        acceptingInput = false;
        pendingInput = [];
        disposeListeners();
        return;
      }

      startRequested = true;
      const startResult = await remotePort.start({
        sessionId,
        executionBinding: isSsh ? tab.binding : LOCAL_EXECUTION_BINDING,
        ...(isSsh ? {} : { cwd: tab.cwd, localShell }),
        cols: latestSize.cols,
        rows: latestSize.rows,
      });
      if (isDisposed()) {
        acceptingInput = false;
        pendingInput = [];
        void stop();
        return;
      }
      if (!isSsh && startResult.shellFallback && localShell?.kind === "custom") {
        term.write(
          `${ansi.dim(translate("terminal.localShellFallback", { path: localShell.executable }))}\r\n`
        );
      }
      if (remoteExited) return;

      remoteStarted = true;
      void remotePort.resize(sessionId, latestSize.cols, latestSize.rows).catch(() => undefined);
      const queuedInput = pendingInput;
      pendingInput = [];
      pendingInputBytes = 0;
      queuedInput.forEach(write);
    } catch (error) {
      acceptingInput = false;
      pendingInput = [];
      pendingInputBytes = 0;
      disposeListeners();
      if (startRequested) void stop();
      if (!isDisposed()) {
        term.write(`${ansi.dim(translate(startFailedKey, { error: String(error) }))}\r\n`);
      }
    }
  })();

  return () => {
    acceptingInput = false;
    pendingInput = [];
    disposeListeners();
    void stop();
  };
}

/** A keyed pane owns one xterm and one immutable PTY session when native transport is available. */
export function TerminalXtermPane({
  tab,
  visible,
  drawerOpen,
  onReady,
  onPasteRequest,
}: TerminalXtermPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalPaneController | null>(null);
  const canFitRef = useRef(visible && drawerOpen);
  canFitRef.current = visible && drawerOpen;
  // A pane is keyed by tab id. Keep the creation snapshot immutable so renaming or
  // selecting a tab can never restart its PTY.
  const tabRef = useRef(tab);
  const callbacksRef = useRef({ onReady, onPasteRequest });
  callbacksRef.current = { onReady, onPasteRequest };
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!visible || !drawerOpen) return;
    const controller = controllerRef.current;
    if (!controller) return;
    const focus = () => {
      controller.fit();
      controller.terminal.focus();
    };
    queueMicrotask(focus);
    const frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [drawerOpen, visible]);

  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const paneTab = tabRef.current;
    let disposed = false;
    let localUnsubscribe: (() => void) | undefined;
    let stopRemote: (() => void) | undefined;
    let mutationObserver: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let webgl: WebglAddon | undefined;
    void (async () => {
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
      webgl = new WebglAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.loadAddon(new WebLinksAddon((_, uri) => openExternal(uri)));
      term.loadAddon(new SearchAddon());

      const isMac = isMacPlatform();
      term.attachCustomKeyEventHandler((event) => {
        if (event.type !== "keydown") return true;
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (!mod || event.altKey) return true;
        const key = event.key.toLowerCase();
        if (key === "c") {
          if (!event.shiftKey && !term.hasSelection()) return true;
          const selection = term.getSelection();
          event.preventDefault();
          if (!selection) return false;
          void copyText(selection);
          term.clearSelection();
          return false;
        }
        if (key === "v") {
          event.preventDefault();
          callbacksRef.current.onPasteRequest();
          return false;
        }
        return true;
      });

      term.open(host);
      if (canFitRef.current) {
        try {
          fit.fit();
        } catch {
          // The drawer can still be growing during its opening animation.
        }
      }
      try {
        term.loadAddon(webgl);
      } catch (error) {
        console.warn("WebGL renderer unavailable, using canvas:", error);
      }

      const controller: TerminalPaneController = {
        terminal: term,
        fit: () => {
          if (!canFitRef.current || host.clientWidth < 2 || host.clientHeight < 2) return;
          try {
            fit.fit();
          } catch {
            // A transition can briefly invalidate xterm's measured dimensions.
          }
        },
      };
      controllerRef.current = controller;
      callbacksRef.current.onReady(paneTab.id, controller);

      const useNativePty = paneTab.kind === "ssh" || getBackendKind() === "desktop-tauri";
      if (useNativePty) {
        stopRemote = startPtyTerminal(
          paneTab,
          term,
          () => disposed,
          ((...args) => tRef.current(...args)) as ReturnType<typeof useT>,
        );
      } else {
        localUnsubscribe = termBus.subscribe((data) => term.write(data));
        term.onData(handleTermInput);
        promptLine();
      }

      resizeObserver = new ResizeObserver(controller.fit);
      resizeObserver.observe(host);
      mutationObserver = new MutationObserver(() => {
        term.options.theme = buildXtermTheme();
      });
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      if (canFitRef.current) term.focus();
    })();

    const onMouseDown = () => controllerRef.current?.terminal.focus();
    host.addEventListener("mousedown", onMouseDown);

    return () => {
      disposed = true;
      localUnsubscribe?.();
      stopRemote?.();
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      host.removeEventListener("mousedown", onMouseDown);
      callbacksRef.current.onReady(paneTab.id, null);
      controllerRef.current?.terminal.dispose();
      controllerRef.current = null;
      webgl?.dispose();
    };
    // The keyed pane owns its terminal for its entire lifetime. Visibility and
    // drawer open/close are handled by the focus effect above, never by teardown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      role="tabpanel"
      aria-labelledby={`terminal-tab-${tab.id}`}
      style={{
        flex: 1,
        minHeight: 0,
        padding: "0 12px 8px 16px",
        display: visible ? "block" : "none",
      }}
    />
  );
}
