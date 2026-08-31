"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ImageOff, Image as ImageIcon } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { imageMime } from "@/lib/image-files";
import { workspaceFsFor } from "@/lib/workspace-target";

/** Replaces the CodeMirror surface when the active file is an image. */
export function ImageViewer({ path }: { path: string }) {
  const t = useT();
  const mock = useWorkspace((s) => s.mock);
  // `path` is a tree entry, so it belongs to whatever host the tree came from.
  // Reading it through the local port would be wrong under a remote target.
  const targetId = useWorkspace((s) => s.targetId);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setSrc(null);
    setError(null);
    setDims(null);
    if (mock) return;
    (async () => {
      try {
        const b64 = await workspaceFsFor(targetId).readFileBase64(path);
        if (alive) setSrc(`data:${imageMime(path)};base64,${b64}`);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [path, mock, targetId]);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        overflow: "auto",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-surface)",
      }}
    >
      {mock && (
        <Placeholder icon={<ImageIcon size={28} strokeWidth={1.5} />}>
          {t("editor.imageMockHint")}
        </Placeholder>
      )}
      {!mock && error && (
        <Placeholder icon={<ImageOff size={28} strokeWidth={1.5} />}>
          {t("editor.imageError")}
          <span
            style={{
              display: "block",
              marginTop: 4,
              fontSize: 11,
              color: "var(--text-tertiary)",
              wordBreak: "break-all",
            }}
          >
            {error}
          </span>
        </Placeholder>
      )}
      {!mock && !error && !src && (
        <Placeholder icon={<ImageIcon size={28} strokeWidth={1.5} />}>
          {t("editor.imageLoading")}
        </Placeholder>
      )}
      {src && (
        <>
          <motion.img
            key={path}
            src={src}
            alt={path}
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            onLoad={(e) => {
              const img = e.currentTarget;
              setDims({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            style={{
              maxWidth: "min(92%, 1200px)",
              maxHeight: "82%",
              objectFit: "contain",
              borderRadius: 8,
              /* checkerboard so transparent regions read as transparent */
              backgroundImage:
                "conic-gradient(rgba(128,128,128,0.18) 0 25%, transparent 0 50%, rgba(128,128,128,0.18) 0 75%, transparent 0)",
              backgroundSize: "16px 16px",
              boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
            }}
          />
          {dims && (
            <div
              style={{
                fontFamily: "var(--font-ui)",
                fontSize: 11.5,
                color: "var(--text-tertiary)",
              }}
            >
              {dims.w} × {dims.h}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Placeholder({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        maxWidth: 360,
        textAlign: "center",
        fontFamily: "var(--font-ui)",
        fontSize: 12.5,
        color: "var(--text-secondary)",
      }}
    >
      <span style={{ color: "var(--text-tertiary)" }}>{icon}</span>
      <div>{children}</div>
    </div>
  );
}
