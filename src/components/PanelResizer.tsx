"use client";

import { useCallback, useEffect, useRef } from "react";

/** arrow key step, px */
const KEY_STEP = 16;
/** Shift+arrow — the conventional precision modifier */
const KEY_STEP_FINE = 4;

export interface PanelResizerProps {
  /**
   * Current size of the panel being resized, in px — its width on a vertical
   * handle, its height on a horizontal one.
   */
  width: number;
  /**
   * Live bounds, read once per drag (and per key press) rather than passed as
   * numbers: the ceiling depends on how much room the row has left right now,
   * which changes with the window and the sidebar.
   */
  bounds: () => { min: number; max: number };
  /**
   * Which side of the containing box the handle is pinned to. The two vertical
   * sides resize width; `top` resizes height, and is what the terminal drawer
   * mounts along its upper seam.
   */
  edge: "left" | "right" | "top";
  /**
   * Which way size grows relative to pointer movement. Defaults to `edge`,
   * which is right whenever the handle sits on the panel it resizes — including
   * `top`, where dragging up has to make the drawer taller.
   *
   * Pass it explicitly when the handle lives on the *neighbour* — work mode
   * mounts this on the chat column's left edge to drive the docked inspector
   * beside it, where dragging right has to widen the inspector, not narrow it.
   */
  grow?: "left" | "right" | "top";
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
  grow = edge,
  onResize,
  onResizeStateChange,
  onCommit,
  onReset,
  label,
}: PanelResizerProps) {
  /**
   * A `top` handle resizes height, so every axis-dependent read below switches
   * on this: the pointer coordinate, which arrow keys mean anything, and the
   * orientation reported to assistive tech. Reading `grow` rather than `edge`
   * covers both — `grow` defaults to `edge`, so a top-edge handle lands here as
   * "top" too, and no caller has reason to mix the two axes.
   */
  const vertical = grow === "top";

  const drag = useRef<{
    /** pointer position along the handle's own axis at press time */
    startPos: number;
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
    drag.current = {
      startPos: vertical ? e.clientY : e.clientX,
      startWidth: width,
      min,
      max,
      moved: false,
    };
    pendingWidth.current = width;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Stop the drag from also landing as a text selection in the transcript.
    e.preventDefault();
    onResizeStateChange?.(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // `left` and `top` both grow as the pointer travels toward the origin.
    const position = vertical ? e.clientY : e.clientX;
    const delta = grow === "right" ? position - d.startPos : d.startPos - position;
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
    // Only the arrows along the handle's own axis do anything: a vertical
    // divider ignores Up/Down, and a horizontal one ignores Left/Right.
    const dir = vertical
      ? e.key === "ArrowUp"
        ? -1
        : e.key === "ArrowDown"
          ? 1
          : 0
      : e.key === "ArrowLeft"
        ? -1
        : e.key === "ArrowRight"
          ? 1
          : 0;
    if (!dir) return;
    e.preventDefault();
    // When the panel grows toward the origin, the arrow that moves the divider
    // *away* from it makes the panel smaller, not larger.
    const step =
      (e.shiftKey ? KEY_STEP_FINE : KEY_STEP) * dir * (grow === "right" ? 1 : -1);
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
      // The orientation of the divider line itself: a handle that resizes
      // height lies horizontally across the top of the panel.
      aria-orientation={vertical ? "horizontal" : "vertical"}
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
