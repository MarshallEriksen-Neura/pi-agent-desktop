"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { Folder, FolderOpen } from "lucide-react";
import { useUI } from "@/lib/store";
import { useChat } from "@/lib/pi/chat";
import { useWorkspace } from "@/lib/workspace";
import { useT } from "@/lib/i18n";
import { isImageFile } from "@/lib/image-files";

/**
 * CodeMirror is ~490 KB of the first-load bundle and nothing is editable until
 * a file is open, so it loads on demand instead of blocking the first paint.
 * `ssr: false` keeps it out of the static-export prerender as well.
 */
const Editor = dynamic(() => import("./Editor").then((m) => m.Editor), {
  ssr: false,
  loading: () => <EditorSkeleton />,
});

const ImageViewer = dynamic(
  () => import("./ImageViewer").then((m) => m.ImageViewer),
  { ssr: false },
);

/** Quiet stand-in that keeps the editor's box while CodeMirror streams in. */
function EditorSkeleton() {
  return (
    <div
      aria-hidden
      style={{
        height: "100%",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-sunken)",
      }}
    />
  );
}

/**
 * Base-layer canvas hosting the CodeMirror surface.
 * In zen mode the column narrows and centers for focused reading.
 */
export function EditorCanvas() {
  const { activeFile, zenMode, agentRunning } = useUI();
  const streaming = useChat((s) => s.streaming);
  const { root, mock, initialized } = useWorkspace();
  const piBusy = agentRunning || streaming;
  const t = useT();

  // no workspace root could be resolved — offer project selection instead
  if (!mock && initialized && root === null) return <WelcomePanel />;

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        height: "100%",
        background: "var(--bg-base)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: zenMode ? 760 : "100%",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          padding: zenMode ? "40px 0 0" : "12px 20px 0",
          transition: "max-width var(--duration-base) var(--spring-smooth), padding var(--duration-base) var(--spring-smooth)",
        }}
      >
        {/* breadcrumb */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontFamily: "var(--font-ui)",
            fontSize: 12,
            color: "var(--text-tertiary)",
            padding: "0 4px 10px",
            flexShrink: 0,
          }}
        >
          <span>{activeFile}</span>
          {agentRunning && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                color: "var(--agent-thinking)",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 99,
                  background: "var(--agent-thinking)",
                  boxShadow: "0 0 0 3px var(--accent-muted)",
                }}
              />
              {t("editor.piEditing")}
            </span>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {isImageFile(activeFile) ? (
            <ImageViewer path={activeFile} />
          ) : (
            <Editor />
          )}
          {/* breathing edge — pi is alive in your editor (Siri-glow mental model) */}
          <AnimatePresence>
            {piBusy && (
              <motion.div
                key="pi-breath"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0.25, 0.55, 0.25] }}
                exit={{ opacity: 0, transition: { duration: 0.4, ease: "easeOut" } }}
                transition={{ duration: 2.2, ease: "easeInOut", repeat: Infinity }}
                style={{
                  position: "absolute",
                  inset: 0,
                  pointerEvents: "none",
                  borderRadius: "var(--radius-sm)",
                  boxShadow:
                    "inset 0 0 24px var(--accent-muted), inset 0 0 0 1.5px var(--agent-thinking)",
                }}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}

/** Shown when no workspace root resolved — pick or reopen a project. */
function WelcomePanel() {
  const { recents, loadError, pickProject, openProject } = useWorkspace();
  const t = useT();

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        height: "100%",
        background: "var(--bg-base)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 28 }}
        style={{
          width: 380,
          maxWidth: "86%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          textAlign: "center",
        }}
      >
        <span style={{ color: "var(--accent)", marginBottom: 4 }}>
          <FolderOpen size={34} strokeWidth={1.5} />
        </span>
        <div style={{ fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>
          {t("project.welcomeTitle")}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {t("project.welcomeBody")}
        </div>
        {loadError && (
          <div style={{ fontSize: 11.5, color: "var(--danger)" }}>{loadError}</div>
        )}
        <button
          onClick={() => void pickProject()}
          style={{
            marginTop: 10,
            padding: "9px 18px",
            fontSize: 13,
            fontWeight: 500,
            color: "#fff",
            background: "var(--accent)",
            border: "none",
            borderRadius: 99,
            cursor: "pointer",
            fontFamily: "var(--font-ui)",
          }}
        >
          {t("project.open")}
        </button>

        {recents.length > 0 && (
          <div style={{ width: "100%", marginTop: 18 }}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                color: "var(--text-tertiary)",
                padding: "0 0 6px",
                textAlign: "left",
              }}
            >
              {t("project.recent")}
            </div>
            {recents.map((r) => (
              <button
                key={r.path}
                className="pi-row"
                onClick={() => void openProject(r.path)}
                title={r.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 9,
                  width: "100%",
                  padding: "8px 10px",
                  border: "none",
                  borderRadius: 9,
                  background: "transparent",
                  cursor: "pointer",
                  textAlign: "left",
                  fontFamily: "var(--font-ui)",
                }}
              >
                <span style={{ color: "var(--accent)", display: "grid", placeItems: "center" }}>
                  <Folder size={14} />
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
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
            ))}
          </div>
        )}
      </motion.div>
    </main>
  );
}
