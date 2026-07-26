"use client";

import { useEffect, useState } from "react";
import {
  MessageSquare,
  ChevronRight,
  Folder,
  FileText,
  Plus,
  Trash2,
} from "lucide-react";
import { motion } from "motion/react";
import { ScrollArea } from "@appica/ui-react/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
} from "@appica/ui-react/collapsible";
import { useUI } from "@/lib/store";
import { useWorkspace, type FsEntry } from "@/lib/workspace";
import { useSessions, type ChatSessionMeta } from "@/lib/pi/sessions";
import { useT } from "@/lib/i18n";
import { SectionLabel } from "./primitives";

/** Left navigation — chat-session history + real workspace file tree. */
export function Sidebar() {
  const { root, entries, init, loadError } = useWorkspace();
  const { sessions, activeId, newSession } = useSessions();
  const t = useT();

  useEffect(() => {
    init();
  }, [init]);

  const rootKey = root ?? "";
  const top = entries[rootKey] ?? [];

  return (
    <nav
      className="material"
      style={{
        width: 248,
        height: "100%",
        borderRight: "1px solid var(--separator)",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <ScrollArea
        orientation="vertical"
        scrollShadow
        style={{ height: "100%" }}
        viewportProps={{ style: { paddingBottom: 16 } }}
      >
        {/* sessions header — label + new-session button */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 10px 6px 16px",
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
            }}
          >
            {t("sidebar.sessions")}
          </span>
          <motion.button
            title={t("sidebar.newSession")}
            aria-label={t("sidebar.newSession")}
            onClick={() => newSession()}
            whileTap={{ scale: 0.85 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            className="pi-row"
            style={{
              display: "grid",
              placeItems: "center",
              width: 22,
              height: 22,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-tertiary)",
              cursor: "pointer",
            }}
          >
            <Plus size={14} />
          </motion.button>
        </div>
        {sessions.map((s) => (
          <SessionRow key={s.id} s={s} active={s.id === activeId} />
        ))}

        <SectionLabel>{t("sidebar.explorer")}</SectionLabel>
        {loadError && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--danger)",
              padding: "2px 16px 6px",
            }}
          >
            {loadError}
          </div>
        )}
        {top.map((e) => (
          <TreeNode key={e.path} entry={e} depth={0} />
        ))}
      </ScrollArea>
    </nav>
  );
}

/**
 * One history row — click to load, double-click to rename inline,
 * hover reveals delete.
 */
function SessionRow({ s, active }: { s: ChatSessionMeta; active: boolean }) {
  const { switchSession, renameSession, deleteSession } = useSessions();
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const t = useT();

  const name = s.name || t("session.untitled");

  const commitRename = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== s.name) renameSession(s.id, draft);
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "relative" }}
    >
      <button
        className="pi-row"
        onClick={() => !editing && switchSession(s.id)}
        onDoubleClick={() => {
          setDraft(s.name);
          setEditing(true);
        }}
        title={s.preview || name}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "calc(100% - 12px)",
          margin: "1px 6px",
          padding: "7px 10px",
          fontSize: 13,
          textAlign: "left",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
          color: active ? "var(--text-primary)" : "var(--text-secondary)",
          background: active ? "var(--accent-muted)" : "transparent",
        }}
      >
        <span style={{ opacity: 0.7, fontSize: 13, width: 15, display: "grid", placeItems: "center" }}><MessageSquare size={14} /></span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 13,
              color: "var(--text-primary)",
              fontFamily: "var(--font-ui)",
            }}
          />
        ) : (
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              // keep the text clear of the hover-revealed delete button
              paddingRight: hover ? 18 : 0,
            }}
          >
            {name}
          </span>
        )}
      </button>
      {hover && !editing && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          title={t("session.delete")}
          aria-label={t("session.delete")}
          onClick={(e) => {
            e.stopPropagation();
            deleteSession(s.id);
          }}
          style={{
            position: "absolute",
            right: 14,
            top: "50%",
            transform: "translateY(-50%)",
            display: "grid",
            placeItems: "center",
            width: 20,
            height: 20,
            border: "none",
            borderRadius: 5,
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
          }}
        >
          <Trash2 size={12} />
        </motion.button>
      )}
    </div>
  );
}

/** Recursive tree row — Collapsible directories animate open, children lazy-load. */
function TreeNode({ entry, depth }: { entry: FsEntry; depth: number }) {
  const { expanded, entries, toggleDir, openFile } = useWorkspace();
  const activeFile = useUI((s) => s.activeFile);

  const isOpen = !!expanded[entry.path];
  const children = entries[entry.path];
  const selected = !entry.isDir && activeFile === entry.path;

  const rowButton = (
    <button
      onClick={() =>
        entry.isDir ? toggleDir(entry.path) : openFile(entry.path)
      }
      className="pi-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "calc(100% - 12px)",
        margin: "1px 6px",
        padding: "5px 8px",
        paddingLeft: 8 + depth * 14,
        fontSize: 12.5,
        textAlign: "left",
        border: "none",
        borderRadius: 7,
        cursor: "pointer",
        color: selected ? "var(--text-primary)" : "var(--text-secondary)",
        background: selected ? "var(--accent-muted)" : "transparent",
        height: "auto",
      }}
    >
      {entry.isDir ? (
        <motion.span
          animate={{ rotate: isOpen ? 90 : 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          style={{
            display: "inline-block",
            width: 12,
            fontSize: 9,
            color: "var(--text-tertiary)",
            flexShrink: 0,
          }}
        >
          <ChevronRight size={12} />
        </motion.span>
      ) : (
        <span style={{ width: 12, flexShrink: 0 }} />
      )}
      <span
        style={{
          fontSize: 12,
          width: 15,
          flexShrink: 0,
          opacity: 0.75,
          color: entry.isDir ? "var(--accent)" : undefined,
        }}
      >
        {entry.isDir ? <Folder size={14} /> : <FileText size={14} />}
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {entry.name}
      </span>
    </button>
  );

  if (!entry.isDir) return rowButton;

  return (
    <Collapsible open={isOpen} onOpenChange={() => toggleDir(entry.path)}>
      {rowButton}
      <CollapsibleContent>
        {(children ?? []).map((c) => (
          <TreeNode key={c.path} entry={c} depth={depth + 1} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
