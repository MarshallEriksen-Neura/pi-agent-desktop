"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, FolderOpen, Folder, Check, X } from "lucide-react";
import { useWorkspace, projectName } from "@/lib/workspace";
import { useT } from "@/lib/i18n";

/**
 * TopBar project switcher — replaces the static subtitle line.
 * Shows the current project name; the dropdown lists recent projects and
 * a native "open folder" picker. Hidden behaviors live in the workspace
 * store (openProject stops pi, resets the tree, restarts pi in the new root).
 */
export function ProjectSwitcher() {
  const { root, mock, recents, switching, pickProject, openProject, removeRecent } =
    useWorkspace();
  const [open, setOpen] = useState(false);
  const t = useT();

  // Backend kind is configured client-side, so prerendered HTML cannot know it.
  // Render nothing until hydrated — matches the server output in both modes.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  // browser preview has no real projects — keep the original static subtitle
  if (mock) {
    return (
      <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
        pi-desktop · main
      </span>
    );
  }

  const name = root ? projectName(root) : t("project.none");

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={root ?? undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: 0,
          border: "none",
          background: "transparent",
          fontSize: 11,
          color: switching ? "var(--accent)" : "var(--text-tertiary)",
          cursor: "pointer",
          fontFamily: "var(--font-ui)",
        }}
      >
        <span
          style={{
            maxWidth: 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {switching ? t("project.switching") : name}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          style={{ display: "grid", placeItems: "center" }}
        >
          <ChevronDown size={11} />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            {/* click-away layer */}
            <div
              onClick={() => setOpen(false)}
              style={{ position: "fixed", inset: 0, zIndex: 60 }}
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: -6 }}
              transition={{ type: "spring", stiffness: 450, damping: 32 }}
              className="material"
              style={{
                position: "absolute",
                top: "calc(100% + 10px)",
                left: -8,
                width: 300,
                zIndex: 61,
                padding: 6,
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--separator)",
                boxShadow: "var(--shadow-lg)",
                transformOrigin: "top left",
              }}
            >
              <div
                style={{
                  padding: "6px 10px 4px",
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: 0.4,
                  textTransform: "uppercase",
                  color: "var(--text-tertiary)",
                }}
              >
                {t("project.recent")}
              </div>

              {recents.length === 0 && (
                <div
                  style={{
                    padding: "6px 10px 8px",
                    fontSize: 12,
                    color: "var(--text-tertiary)",
                  }}
                >
                  {t("project.noRecents")}
                </div>
              )}

              {recents.map((r) => {
                const current = r.path === root;
                return (
                  <div
                    key={r.path}
                    className="pi-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      borderRadius: 8,
                      background: current ? "var(--accent-muted)" : "transparent",
                    }}
                  >
                    <button
                      onClick={() => {
                        setOpen(false);
                        if (!current) void openProject(r.path);
                      }}
                      title={r.path}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "7px 4px 7px 10px",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        fontFamily: "var(--font-ui)",
                      }}
                    >
                      <span
                        style={{
                          color: "var(--accent)",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Folder size={14} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span
                          style={{
                            display: "block",
                            fontSize: 12.5,
                            color: "var(--text-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.name}
                        </span>
                        <span
                          style={{
                            display: "block",
                            fontSize: 10.5,
                            color: "var(--text-tertiary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {r.path}
                        </span>
                      </span>
                    </button>
                    {current ? (
                      <span
                        style={{
                          color: "var(--accent)",
                          padding: "0 10px",
                          display: "grid",
                          placeItems: "center",
                        }}
                      >
                        <Check size={13} />
                      </span>
                    ) : (
                      <button
                        onClick={() => void removeRecent(r.path)}
                        title={t("project.remove")}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: "var(--text-tertiary)",
                          padding: "0 10px",
                          cursor: "pointer",
                          display: "grid",
                          placeItems: "center",
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                );
              })}

              <div
                style={{
                  height: 1,
                  background: "var(--separator)",
                  margin: "6px 4px",
                }}
              />

              <button
                className="pi-row"
                onClick={() => {
                  setOpen(false);
                  void pickProject();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "8px 10px",
                  border: "none",
                  borderRadius: 8,
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: 12.5,
                  color: "var(--text-primary)",
                  textAlign: "left",
                  fontFamily: "var(--font-ui)",
                }}
              >
                <span style={{ color: "var(--accent)", display: "grid", placeItems: "center" }}>
                  <FolderOpen size={14} />
                </span>
                {t("project.open")}
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
