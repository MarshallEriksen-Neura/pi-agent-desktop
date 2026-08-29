"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface TerminalMenuItem {
  label: string;
  onSelect: () => void;
  /** Shown right-aligned — the keyboard route to the same action. */
  hint?: string;
  disabled?: boolean;
}

export interface TerminalMenuState {
  x: number;
  y: number;
  items: TerminalMenuItem[];
}

const MENU_W = 188;
const ITEM_H = 28;
const PAD = 8;

/**
 * Right-click menu for the terminal drawer.
 *
 * The terminal needs its own because [AppShell.tsx](./AppShell.tsx) cancels
 * `contextmenu` for the whole desktop app, which takes WebView2's Copy/Paste
 * items with it — and right-click is where a user goes when a key binding is not
 * discoverable.
 *
 * Rendered through a portal: the drawer animates its height with `overflow:
 * hidden`, and Motion's transform on that element makes it a containing block
 * for fixed positioning, so a menu rendered in place would be clipped by the
 * drawer it belongs to.
 */
export function TerminalContextMenu({
  state,
  onClose,
}: {
  state: TerminalMenuState;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay so the mouseup/mousedown pair that opened the menu cannot close it.
    const tid = setTimeout(() => document.addEventListener("mousedown", onDown), 50);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    // Capture phase: the terminal's own scrollers do not bubble scroll events.
    document.addEventListener("scroll", onClose, true);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const menuH = state.items.length * ITEM_H + PAD;
  const left = Math.min(state.x, window.innerWidth - MENU_W - 8);
  const top = Math.min(state.y, window.innerHeight - menuH - 8);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed",
        left: Math.max(8, left),
        top: Math.max(8, top),
        width: MENU_W,
        zIndex: 100,
        padding: 4,
        background: "var(--bg-elevated)",
        border: "1px solid var(--separator)",
        borderRadius: 8,
        boxShadow: "0 8px 28px rgba(0,0,0,0.32)",
      }}
    >
      {state.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            height: ITEM_H - 2,
            padding: "0 8px",
            border: "none",
            borderRadius: 5,
            background: "transparent",
            color: item.disabled ? "var(--text-tertiary)" : "var(--text-primary)",
            cursor: item.disabled ? "default" : "pointer",
            fontSize: 12,
            textAlign: "left",
            opacity: item.disabled ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            if (!item.disabled) e.currentTarget.style.background = "var(--bg-base)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <span style={{ flex: 1 }}>{item.label}</span>
          {item.hint && (
            <span
              style={{
                fontSize: 10.5,
                color: "var(--text-tertiary)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {item.hint}
            </span>
          )}
        </button>
      ))}
    </div>,
    document.body
  );
}
