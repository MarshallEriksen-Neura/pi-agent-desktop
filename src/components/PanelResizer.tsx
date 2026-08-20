"use client";

import { useCallback, useEffect, useRef } from "react";

/** arrow key step, px */
const KEY_STEP = 16;
/** Shift+arrow — the conventional precision modifier */
const KEY_STEP_FINE = 4;

export interface PanelResizerProps {
  /** current width of the panel being resized, in px */
  width: number;
  /**
   * Live bounds, read once per drag (and per key press) rather than passed as
   * numbers: the ceiling depends on how much room the row has left right now,
   * which changes with the window and the sidebar.
   */
  bounds: () => { min: number; max: number };
  /** which way width grows relative to pointer movement */
  edge: "left" | "right";
  /** fired at most once per frame while dragging */
  onResize: (px: number) => void;
  /** drag started / ended — lets the caller drop its width transition */
  onResizeStateChange?: (resizing: boolean) => void;
  /** drag settled: persist the final width */
  onCommit?: () => void;
  /** double-click / Home — back to the default width */
  onReset?: () => void;
  label: string;
}

/**
 * A one-pixel divider with a forgiving hit area, dragged to resize the panel
 * beside it.
 *
 * Pointer capture (not window listeners) keeps the drag alive when the cursor
 * outruns the handle or leaves the window, and cleans itself up if the pointer
 * is lost — a stuck drag would otherwise resize the panel on plain mouse moves.
 */
export function PanelResizer({
  width,
  bounds,
  edge,
  onResize,
  onResizeStateChange,
  onCommit,
  onReset,
  label,
}: PanelResizerProps) {
  const drag = useRef<{
    startX: number;
    startWidth: number;
    min: number;
    max: number;
    /** whether any pointermove actually landed — a click must not resize */
    moved: boolean;
  } | null>(null);
  /** rAF-coalesced: a fast mouse fires several pointermove per frame */
  const frame = useRef(0);
  const pendingWidth = useRef(0);

  const cancelFrame = useCallback(() => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
  }, []);

  useEffect(() => cancelFrame, [cancelFrame]);

  const clampTo = (px: number, min: number, max: number) =>
    Math.round(Math.min(max, Math.max(min, px)));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Left button only — a right-click here should fall through to the menu.
    if (e.button !== 0) return;
    const { min, max } = bounds();
    drag.current = { startX: e.clientX, startWidth: width, min, max, moved: false };
    pendingWidth.current = width;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Stop the drag from also landing as a text selection in the transcript.
    e.preventDefault();
    onResizeStateChange?.(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const delta = edge === "left" ? d.startX - e.clientX : e.clientX - d.startX;
    d.moved = true;
    pendingWidth.current = clampTo(d.startWidth + delta, d.min, d.max);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (drag.current) onResize(pendingWidth.current);
    });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelFrame();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onResizeStateChange?.(false);
    // A press with no movement is a click (or the first half of a double-click)
    // and must leave the width alone.
    if (!d.moved) return;
    // Land the last sampled position — the pending frame may not have run.
    onResize(pendingWidth.current);
    onCommit?.();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Home") {
      e.preventDefault();
      onReset?.();
      return;
    }
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    // On a left-edge handle, ArrowRight moves the divider right — which makes
    // the panel narrower, not wider.
    const step = (e.shiftKey ? KEY_STEP_FINE : KEY_STEP) * dir * (edge === "left" ? -1 : 1);
    const { min, max } = bounds();
    onResize(clampTo(width + step, min, max));
    onCommit?.();
  };

  // A focusable separator reports its range in the same unit as its value, so
  // px bounds beat the 0–100 default. `bounds` is a pure read of the caller's
  // current layout, which is why it's safe to call here.
  const { min, max } = bounds();

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={label}
      className="panel-resizer"
      data-edge={edge}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => {
        // Safety net: capture can be revoked without pointerup (window blur,
        // touch interruption). Don't leave the handle thinking it's mid-drag.
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        cancelFrame();
        onResizeStateChange?.(false);
        if (d.moved) onCommit?.();
      }}
      onDoubleClick={() => onReset?.()}
    />
  );
}
