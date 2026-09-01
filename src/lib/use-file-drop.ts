"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { getPort } from "./backend/composition/container";
import { isDropInside } from "./terminal-drop";

/**
 * An element-sized drop zone built on a window-sized event.
 *
 * The platform reports drags against the window, not against a node (see
 * [file-drop.ts](./backend/ports/file-drop.ts)), so "is this drop mine?" is
 * answered by measuring the element on every event rather than by letting the
 * DOM route it. Measuring per event rather than once is deliberate: the terminal
 * drawer animates its height open, and a rect captured on subscribe would be the
 * wrong box for the whole first drag.
 */
export interface FileDropZone {
  enabled: boolean;
  targetRef: RefObject<HTMLElement | null>;
  onDrop: (paths: string[]) => void;
}

/** Subscribes while `enabled`, and reports whether a drag is over the target. */
export function useFileDropZone({ enabled, targetRef, onDrop }: FileDropZone): boolean {
  const [over, setOver] = useState(false);
  // Kept in a ref so a new handler identity (it closes over the current runtime
  // mode and view) does not tear down and re-establish the subscription.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    if (!enabled) {
      setOver(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const isOverTarget = (position: { x: number; y: number }) => {
      const element = targetRef.current;
      if (!element) return false;
      return isDropInside(
        position,
        element.getBoundingClientRect(),
        window.devicePixelRatio
      );
    };

    (async () => {
      try {
        const stop = await getPort("fileDrop").onDrag((event) => {
          if (disposed) return;
          switch (event.type) {
            case "enter":
            case "over":
              setOver(isOverTarget(event.position));
              break;
            case "leave":
              setOver(false);
              break;
            case "drop": {
              const hit = isOverTarget(event.position);
              setOver(false);
              if (hit && event.paths.length > 0) onDropRef.current(event.paths);
              break;
            }
          }
        });
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
      } catch (error) {
        // Drag-and-drop is an affordance, not a dependency: a backend without it
        // (browser preview) or one not yet configured leaves the zone inert.
        console.warn("Drag-and-drop is unavailable:", error);
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, targetRef]);

  return enabled && over;
}
