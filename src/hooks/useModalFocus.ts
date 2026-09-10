"use client";

import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface ModalFocusOptions {
  open: boolean;
  /** Suspend this modal while a child modal owns keyboard focus. */
  paused?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onEscape: () => void;
}

/**
 * Gives a custom modal the keyboard behavior normally supplied by <dialog>:
 * initial focus, Escape, a Tab loop, and focus restoration on close.
 */
export function useModalFocus<T extends HTMLElement>({
  open,
  paused = false,
  initialFocusRef,
  onEscape,
}: ModalFocusOptions): RefObject<T | null> {
  const containerRef = useRef<T>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const latestEscapeRef = useRef(onEscape);
  latestEscapeRef.current = onEscape;
  const latestPausedRef = useRef(paused);
  latestPausedRef.current = paused;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      (initialFocusRef?.current ?? containerRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected) previous.focus();
    };
  }, [open, initialFocusRef]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (latestPausedRef.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latestEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const container = containerRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  return containerRef;
}
