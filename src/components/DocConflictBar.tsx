"use client";

import { AlertTriangle } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { useT } from "@/lib/i18n";

/**
 * The file changed on the host while it was open here.
 *
 * Deliberately not an error toast. A refused write is not a failure — it is a fork:
 * two versions exist and only the user knows which one is wanted. pi editing the same
 * tree makes this a routine event, not an exception, so it gets a persistent bar with
 * two named outcomes rather than a message that scrolls away.
 *
 * The bar stays until one is chosen; the local edits are still in the buffer either way,
 * so nothing is lost while it is up.
 */
export function DocConflictBar({ path }: { path: string }) {
  const t = useT();
  const conflict = useWorkspace((state) => state.conflicts[path]);
  const takeRemote = useWorkspace((state) => state.resolveConflictWithRemote);
  const keepLocal = useWorkspace((state) => state.resolveConflictWithLocal);
  if (conflict === undefined) return null;

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        margin: "0 4px 8px",
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--warning)",
        background: "var(--warning-muted, transparent)",
        fontFamily: "var(--font-ui)",
        fontSize: 12,
        color: "var(--text-primary)",
      }}
    >
      <AlertTriangle size={14} style={{ color: "var(--warning)", flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        {conflict.currentHash === null
          ? t("editor.conflict.deleted")
          : t("editor.conflict.changed")}
      </span>
      <button onClick={() => void takeRemote(path)} style={choiceStyle(false)}>
        {t("editor.conflict.takeRemote")}
      </button>
      <button onClick={() => void keepLocal(path)} style={choiceStyle(true)}>
        {t("editor.conflict.keepLocal")}
      </button>
    </div>
  );
}

const choiceStyle = (primary: boolean): React.CSSProperties => ({
  flexShrink: 0,
  padding: "4px 10px",
  borderRadius: 6,
  border: primary ? "none" : "1px solid var(--separator)",
  background: primary ? "var(--warning)" : "transparent",
  color: primary ? "var(--warning-contrast, #1a1a1a)" : "var(--text-secondary)",
  fontSize: 11.5,
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
});
