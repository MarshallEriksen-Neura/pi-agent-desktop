"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Folder, FileText } from "lucide-react";
import { isDirectoryPath, pathLeaf, pathParent } from "@/lib/file-match";
import { useT } from "@/lib/i18n";

/** Why the menu has no rows to show. `ready` means the rows are real. */
export type MentionStatus = "ready" | "loading" | "unsupported" | "empty";

/** The last two path segments, elided at the front when there are more. */
function tailSegments(parent: string): string {
  const segments = parent.split("/").filter(Boolean);
  return segments.length > 2 ? `…/${segments.slice(-2).join("/")}` : parent;
}

/**
 * Composer file-mention popover — the list behind `@`.
 *
 * Sibling of `SlashCommandMenu` and deliberately the same shape, because the two
 * are the same interaction to the person using them. It differs in what it says
 * when there is nothing to list: a slash menu with no matches simply closes, while
 * `@` has three distinct empty states (still walking, this target has no index, no
 * path matches) and closing on all of them would read as the feature being broken.
 *
 * Keyboard state (`activeIndex`) is owned by the composer, as with the slash menu;
 * this renders and reports hover/click.
 */
export function FileMentionMenu({
  open,
  items,
  activeIndex,
  status,
  truncated,
  onHover,
  onSelect,
}: {
  open: boolean;
  /** Relative paths, best match first. Directories end with `/`. */
  items: string[];
  activeIndex: number;
  status: MentionStatus;
  /** The index hit its cap, so a path missing here may still exist. */
  truncated: boolean;
  onHover: (index: number) => void;
  onSelect: (path: string) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);
  const t = useT();

  /* keep the keyboard-highlighted row visible while navigating */
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const message =
    status === "loading"
      ? t("mention.loading")
      : status === "unsupported"
        ? t("mention.unsupported")
        : status === "empty"
          ? t("mention.empty")
          : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 500, damping: 32 }}
          className="material-thick"
          role="listbox"
          style={{
            position: "absolute",
            bottom: "100%",
            left: 12,
            right: 12,
            marginBottom: 8,
            maxHeight: 240,
            overflowY: "auto",
            padding: 6,
            border: "1px solid var(--separator)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 60,
          }}
        >
          {message !== null ? (
            <div
              style={{
                padding: "7px 10px",
                fontSize: 12,
                color: "var(--text-tertiary)",
              }}
            >
              {message}
            </div>
          ) : (
            items.map((path, i) => {
              const active = i === activeIndex;
              const isDir = isDirectoryPath(path);
              const parent = pathParent(path);
              return (
                <div
                  key={path}
                  ref={active ? activeRef : undefined}
                  role="option"
                  aria-selected={active}
                  /* mousedown so the composer input never loses focus */
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(path);
                  }}
                  onMouseEnter={() => onHover(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: active ? "var(--separator)" : "transparent",
                  }}
                >
                  <span
                    style={{
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                      opacity: 0.75,
                      color: isDir ? "var(--accent)" : undefined,
                    }}
                  >
                    {isDir ? <Folder size={13} /> : <FileText size={13} />}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-primary)",
                      flexShrink: 0,
                      maxWidth: "60%",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {pathLeaf(path)}
                  </span>
                  {/* The directory disambiguates two files with the same name, and
                      it is the *tail* that does it — `…/lib/pi` says more than
                      `src/compo…`. Trimmed by segment rather than with an RTL
                      text-overflow trick, which reorders a leading dot (`.claude`
                      renders as `claude.`). */}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11,
                      color: "var(--text-tertiary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {tailSegments(parent)}
                  </span>
                </div>
              );
            })
          )}

          {truncated && status !== "unsupported" && (
            <div
              style={{
                padding: "5px 10px 2px",
                fontSize: 10.5,
                color: "var(--text-tertiary)",
                opacity: 0.8,
              }}
            >
              {t("mention.truncated")}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
