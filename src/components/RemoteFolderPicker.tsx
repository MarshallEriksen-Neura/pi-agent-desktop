"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Folder, LoaderCircle, Server } from "lucide-react";
import { getPort } from "@/lib/backend/composition/container";
import type { FsEntryDto } from "@/lib/backend/ports/workspace-fs";
import type { WorkspaceTargetId } from "@/lib/workspace-target";
import { useT } from "@/lib/i18n";

/**
 * Choosing a directory on a remote host.
 *
 * The app has to draw this itself: `pick()` returns a path from a native OS dialog, and
 * no version of that call can enumerate a directory over SSH. That is the gap the
 * `browse(targetId)` port exists to fill.
 *
 * Every level is one SSH round trip, so this deliberately does not pretend to be a
 * native dialog. Navigation shows its own loading state and only ever fetches the level
 * being opened — a dialog that felt instant and then stalled would be worse than one
 * that looks like what it is.
 */

interface RemoteFolderPickerProps {
  targetId: WorkspaceTargetId;
  /** Host label for the header — the profile's display name, not the alias. */
  hostLabel: string;
  onCancel: () => void;
  onChoose: (path: string) => void;
}

const parentOf = (path: string): string | null => {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return null;
  return cut === 0 ? "/" : trimmed.slice(0, cut);
};

export function RemoteFolderPicker({
  targetId,
  hostLabel,
  onCancel,
  onChoose,
}: RemoteFolderPickerProps) {
  const t = useT();
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (next?: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await getPort("projectCatalog").browse(targetId, next);
        setPath(result.path);
        setEntries(result.entries.filter((entry) => entry.isDir));
      } catch (cause) {
        // Surfaced, not swallowed: the launcher's codes distinguish "no permission"
        // from "gone", and a browser that silently showed an empty directory for both
        // would be indistinguishable from a directory that really is empty.
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [targetId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const parent = path ? parentOf(path) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <Server size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
          {hostLabel}
        </span>
        {loading && (
          <LoaderCircle size={12} className="animate-spin" style={{ color: "var(--text-tertiary)" }} />
        )}
      </div>

      <div
        title={path ?? undefined}
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          direction: "rtl",
          textAlign: "left",
        }}
      >
        {path ?? "…"}
      </div>

      {error !== null && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--danger)",
            background: "var(--danger-muted, transparent)",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          maxHeight: 240,
          overflowY: "auto",
          border: "1px solid var(--separator)",
          borderRadius: 8,
        }}
      >
        {parent !== null && (
          <button
            className="pi-row"
            onClick={() => void load(parent)}
            disabled={loading}
            style={rowStyle}
          >
            <Folder size={13} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
            <span style={{ flex: 1, textAlign: "left" }}>..</span>
          </button>
        )}
        {!loading && entries.length === 0 && error === null && (
          <div style={{ padding: "10px 12px", fontSize: 11.5, color: "var(--text-tertiary)" }}>
            {t("remoteAgent.browse.empty")}
          </div>
        )}
        {entries.map((entry) => (
          <button
            key={entry.path}
            className="pi-row"
            onClick={() => void load(entry.path)}
            disabled={loading}
            title={entry.path}
            style={rowStyle}
          >
            <Folder size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {entry.name}
            </span>
            <ChevronRight size={12} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={buttonStyle(false)}>
          {t("common.cancel")}
        </button>
        <button
          onClick={() => path !== null && onChoose(path)}
          disabled={path === null || loading}
          style={buttonStyle(true)}
        >
          {t("remoteAgent.browse.useThis")}
        </button>
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 10px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12.5,
  color: "var(--text-primary)",
  fontFamily: "var(--font-ui)",
};

const buttonStyle = (primary: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 7,
  border: primary ? "none" : "1px solid var(--separator)",
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "var(--accent-contrast, #fff)" : "var(--text-secondary)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
});
