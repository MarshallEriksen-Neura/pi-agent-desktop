"use client";

import { createContext, useContext, useEffect, useRef, useState, memo, useMemo } from "react";
import {
  MessageSquare,
  ChevronRight,
  Folder,
  FileText,
  Plus,
  Trash2,
  FilePlus2,
  FolderPlus,
  Pencil,
  Smartphone,
  RefreshCw,
  AtSign,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { ScrollArea } from "@appica/ui-react/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
} from "@appica/ui-react/collapsible";
import { useUI } from "@/lib/store";
import { useWorkspace, type FsEntry } from "@/lib/workspace";
import { composerBus } from "@/lib/composer-bus";
import { buildMentionValue, relativeToRoot } from "@/lib/file-match";
import { useSessions, type ChatSessionMeta } from "@/lib/pi/sessions";
import { getChatStore } from "@/lib/pi/chat";
import { getPiStore } from "@/lib/pi/store";
import { useRemoteConversations } from "@/lib/remote-conversations/store";
import type { RemoteConversationSnapshot } from "@pi/remote-control-contracts";
import { useT } from "@/lib/i18n";
import { SectionLabel } from "./primitives";

//─── Tree editing context ─────────────────────────────────────────────────────

interface TreeEditCtxValue {
  renamingPath: string | null;
  creatingIn: { dirPath: string; type: "file" | "dir" } | null;
  focusedEntry: FsEntry | null;
  setFocusedEntry: (entry: FsEntry | null) => void;
  startRename: (path: string) => void;
  startCreate: (dirPath: string, type: "file" | "dir") => void;
  commitRename: (entry: FsEntry, newName: string) => Promise<void>;
  cancelRename: () => void;
  commitCreate: (dirPath: string, name: string, type: "file" | "dir") => Promise<void>;
  cancelCreate: () => void;
  showCtxMenu: (e: React.MouseEvent, entry: FsEntry) => void;
}

const TreeEditCtx = createContext<TreeEditCtxValue>({
  renamingPath: null,
  creatingIn: null,
  focusedEntry: null,
  setFocusedEntry: () => {},
  startRename: () => {},
  startCreate: () => {},
  commitRename: async () => {},
  cancelRename: () => {},
  commitCreate: async () => {},
  cancelCreate: () => {},
  showCtxMenu: () => {},
});

//─── Context menu ─────────────────────────────────────────────────────────────

interface CtxMenuState { x: number; y: number; entry: FsEntry }

function ContextMenu({ state, onClose }: { state: CtxMenuState; onClose: () => void }) {
  const { startRename, startCreate } = useContext(TreeEditCtx);
  const { deleteEntry, root } = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Delay so the triggering right-click doesn't immediately close the menu
    const tid = setTimeout(() => document.addEventListener("mousedown", onDown), 50);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const menuW = 172;
  // Measured, not guessed: this decides whether the menu flips above the click, so
  // a value that has drifted from the item list puts the menu off-screen near the
  // bottom edge. 30px per row, 7px per separator, 8px of padding.
  const menuH = state.entry.isDir ? 196 : 124;
  const left = state.x + menuW > window.innerWidth ? state.x - menuW : state.x;
  const top  = state.y + menuH > window.innerHeight ? state.y - menuH : state.y;

  type MenuItem =
    | { separator: true }
    | { label: string; icon: React.ReactNode; danger?: boolean; action: () => void };

  /**
   * Put the path in the composer as an `@`-mention.
   *
   * Relative to the project root, which is what Pi resolves against the execution
   * target's own cwd. A directory keeps its trailing slash so the mention
   * reads as one.
   */
  const mentionEntry = () => {
    const relative = relativeToRoot(state.entry.path, root);
    const path = state.entry.isDir ? `${relative}/` : relative;
    composerBus.insert(buildMentionValue(path, { quoted: false, open: false }));
    onClose();
  };

  const dirItems: MenuItem[] = [
    { label: t("ctx.mention"),   icon: <AtSign size={12} />, action: mentionEntry },
    { separator: true },
    { label: t("ctx.newFile"),   icon: <FilePlus2 size={12} />, action: () => { startCreate(state.entry.path, "file"); onClose(); } },
    { label: t("ctx.newFolder"), icon: <FolderPlus size={12} />, action: () => { startCreate(state.entry.path, "dir"); onClose(); } },
    { separator: true },
    { label: t("ctx.rename"),    icon: <Pencil size={12} />, action: () => { startRename(state.entry.path); onClose(); } },
    { separator: true },
    { label: t("ctx.delete"),    icon: <Trash2 size={12} />, danger: true, action: () => { onClose(); void deleteEntry(state.entry.path, true); } },
  ];

  const fileItems: MenuItem[] = [
    { label: t("ctx.mention"),   icon: <AtSign size={12} />, action: mentionEntry },
    { separator: true },
    { label: t("ctx.rename"),    icon: <Pencil size={12} />, action: () => { startRename(state.entry.path); onClose(); } },
    { separator: true },
    { label: t("ctx.delete"),    icon: <Trash2 size={12} />, danger: true, action: () => { onClose(); void deleteEntry(state.entry.path, false); } },
  ];

  const items = state.entry.isDir ? dirItems : fileItems;

  return (
    <div
      ref={ref}
      role="menu"
      style={{
        position: "fixed", left, top, zIndex: 9999, minWidth: menuW,
        background: "var(--surface-elevated, var(--bg-secondary))",
        border: "1px solid var(--separator)",
        borderRadius: 10,
        boxShadow: "0 8px 32px rgba(0,0,0,.20), 0 2px 8px rgba(0,0,0,.12)",
        padding: "4px 0",
        backdropFilter: "blur(24px)",
      }}
    >
      {items.map((item, i) =>
        "separator" in item ? (
          <div key={i} style={{ height: 1, background: "var(--separator)", margin: "3px 0" }} />
        ) : (
          <button
            key={i}
            role="menuitem"
            onClick={item.action}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", padding: "6px 14px", fontSize: 12.5,
              border: "none", background: "transparent",
              color: item.danger ? "var(--danger)" : "var(--text-primary)",
              cursor: "pointer", textAlign: "left",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = item.danger
                ? "rgba(239,68,68,.1)" : "var(--accent-muted)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <span style={{ opacity: 0.75, display: "grid", placeItems: "center" }}>{item.icon}</span>
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

//─── Inline input (create / rename) ───────────────────────────────────────────

function InlineInput({
  placeholder,
  initialValue = "",
  onCommit,
  onCancel,
  depth = 0,
}: {
  placeholder: string;
  initialValue?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  depth?: number;
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "4px 8px",
        paddingLeft: 8 + depth * 14,
        margin: "1px 6px",
      }}
    >
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value.trim()) onCommit(value.trim());
          else onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onCommit(value.trim());
          if (e.key === "Escape") onCancel();
        }}
        style={{
          flex: 1,
          fontSize: 12.5,
          padding: "3px 6px",
          border: "1px solid var(--accent)",
          borderRadius: 5,
          background: "var(--bg-primary)",
          color: "var(--text-primary)",
          outline: "none",
          fontFamily: "var(--font-ui)",
        }}
      />
    </div>
  );
}

//─── Sidebar ──────────────────────────────────────────────────────────────────

/** When the session history exceeds this many rows, fold the rest behind a
 *  "show all" toggle so the sidebar renders quickly and stays scannable. */
const SESSION_COLLAPSE_THRESHOLD = 8;

/** Left navigation — chat-session history + real workspace file tree. */
export function Sidebar() {
  const workspace = useWorkspace();
  const { root, entries, init, loadError } = workspace;
  const { sessions, activeId, newSession } = useSessions();
  const t = useT();

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingIn, setCreatingIn] = useState<{ dirPath: string; type: "file" | "dir" } | null>(null);
  const [explorerHover, setExplorerHover] = useState(false);
  const [focusedEntry, setFocusedEntry] = useState<FsEntry | null>(null);
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  /* work-only is the one layout with no editor to open a file into — see the
     Explorer section below. The workspace still initializes: its root is what
     the agent runs against, whether or not a tree is drawn. */
  const showExplorer = useUI((s) => s.layoutMode !== "work-only");

  useEffect(() => {
    init();
  }, [init]);

  const treeCtx: TreeEditCtxValue = {
    renamingPath,
    creatingIn,
    focusedEntry,
    setFocusedEntry,
    startRename: (path) => {
      setCtxMenu(null);
      setRenamingPath(path);
    },
    startCreate: (dirPath, type) => {
      setCtxMenu(null);
      setCreatingIn({ dirPath, type });
    },
    commitRename: async (entry, newName) => {
      await workspace.renameEntry(entry.path, newName);
      setRenamingPath(null);
    },
    cancelRename: () => setRenamingPath(null),
    commitCreate: async (dirPath, name, type) => {
      if (type === "file") await workspace.createFile(dirPath, name);
      else await workspace.createDir(dirPath, name);
      setCreatingIn(null);
    },
    cancelCreate: () => setCreatingIn(null),
    showCtxMenu: (e, entry) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, entry });
    },
  };

  const rootKey = root ?? "";
  const top = entries[rootKey] ?? [];

  // Sessions list: collapse when it grows past a threshold so the sidebar stays
  // snappy. The active session is always kept visible even when folded.
  const visibleSessions = useMemo(() => {
    if (sessionsExpanded || sessions.length <= SESSION_COLLAPSE_THRESHOLD) {
      return sessions;
    }
    const head = sessions.slice(0, SESSION_COLLAPSE_THRESHOLD);
    if (activeId && !head.some((s) => s.id === activeId)) {
      const active = sessions.find((s) => s.id === activeId);
      if (active) return [...head, active];
    }
    return head;
  }, [sessions, sessionsExpanded, activeId]);

  // Context-aware creation: create in the focused directory, or root if no focus
  const createInContext = (type: "file" | "dir") => {
    let targetDir = rootKey;

    if (focusedEntry) {
      // If focused entry is a directory, create inside it
      // If focused entry is a file, create in its parent directory
      if (focusedEntry.isDir) {
        targetDir = focusedEntry.path;
        // Expand the directory if not already open
        if (!workspace.expanded[targetDir]) {
          void workspace.toggleDir(targetDir);
        }
      } else {
        // File → get parent directory
        const lastSlash = focusedEntry.path.lastIndexOf("/");
        targetDir = lastSlash > 0 ? focusedEntry.path.substring(0, lastSlash) : rootKey;
      }
    }

    treeCtx.startCreate(targetDir, type);
  };

  return (
    <TreeEditCtx.Provider value={treeCtx}>
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
          {visibleSessions.map((s) => (
            <SessionRow key={s.id} s={s} active={s.id === activeId} />
          ))}
          {sessions.length > SESSION_COLLAPSE_THRESHOLD && (
            <motion.button
              whileTap={{ scale: 0.97 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              onClick={() => setSessionsExpanded((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                width: "calc(100% - 12px)",
                margin: "2px 6px",
                padding: "6px 10px",
                fontSize: 12,
                textAlign: "left",
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: "var(--text-tertiary)",
                cursor: "pointer",
              }}
            >
              <ChevronRight
                size={12}
                style={{
                  display: "inline-block",
                  transform: sessionsExpanded ? "rotate(90deg)" : "none",
                  transition: "transform 0.15s ease",
                }}
              />
              <span>
                {sessionsExpanded
                  ? t("sidebar.collapseSessions")
                  : t("sidebar.showAllSessions", { count: sessions.length })}
              </span>
            </motion.button>
          )}

          {/* conversations started on a paired phone — same list, own section */}
          <RemoteSection />

          {/* The tree's primary action opens a file into the editor, so with the
              editor removed it would read a whole file into the doc cache, mark
              the row selected, and show nothing — a control that reports success
              and does nothing. Its remaining powers (new / rename / delete) are
              the manual work this layout exists to hand to the agent, so the
              whole section goes rather than being trimmed to those. */}
          {showExplorer && (
          <>
          {/* Explorer header — label + hover-revealed new-file / new-folder buttons */}
          <div
            onMouseEnter={() => setExplorerHover(true)}
            onMouseLeave={() => setExplorerHover(false)}
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
              {t("sidebar.explorer")}
            </span>
            <AnimatePresence>
              {explorerHover && root && (
                <motion.div
                  key="explorer-actions"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  style={{ display: "flex", gap: 2 }}
                >
                  <motion.button
                    title={t("ctx.newFile")}
                    aria-label={t("ctx.newFile")}
                    onClick={() => createInContext("file")}
                    whileTap={{ scale: 0.82 }}
                    transition={{ type: "spring", stiffness: 500, damping: 24 }}
                    style={{
                      display: "grid",
                      placeItems: "center",
                      width: 22,
                      height: 22,
                      border: "none",
                      borderRadius: 5,
                      background: "transparent",
                      color: "var(--text-tertiary)",
                      cursor: "pointer",
                    }}
                  >
                    <FilePlus2 size={14} />
                  </motion.button>
                  <motion.button
                    title={t("ctx.newFolder")}
                    aria-label={t("ctx.newFolder")}
                    onClick={() => createInContext("dir")}
                    whileTap={{ scale: 0.82 }}
                    transition={{ type: "spring", stiffness: 500, damping: 24 }}
                    style={{
                      display: "grid",
                      placeItems: "center",
                      width: 22,
                      height: 22,
                      border: "none",
                      borderRadius: 5,
                      background: "transparent",
                      color: "var(--text-tertiary)",
                      cursor: "pointer",
                    }}
                  >
                    <FolderPlus size={14} />
                  </motion.button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {loadError && (
            <div style={{ fontSize: 11.5, color: "var(--danger)", padding: "2px 16px 6px" }}>
              {loadError}
            </div>
          )}

          {/* Root-level inline create — when triggered from the header buttons */}
          {creatingIn?.dirPath === rootKey && (
            <InlineInput
              placeholder={
                creatingIn.type === "file"
                  ? t("ctx.newFilePlaceholder")
                  : t("ctx.newFolderPlaceholder")
              }
              onCommit={(name) => void treeCtx.commitCreate(rootKey, name, creatingIn.type)}
              onCancel={treeCtx.cancelCreate}
              depth={0}
            />
          )}

          {top.map((e) => (
            <TreeNode key={e.path} entry={e} depth={0} />
          ))}
          </>
          )}
        </ScrollArea>
      </nav>

      {/* Floating context menu */}
      <AnimatePresence>
        {ctxMenu && (
          <motion.div
            key="ctx"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: 0.1 }}
          >
            <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />
          </motion.div>
        )}
      </AnimatePresence>
    </TreeEditCtx.Provider>
  );
}

//─── RemoteSection ────────────────────────────────────────────────────────────

/**
 * Conversations started from a paired phone, listed under the local sessions so
 * picking one up on the desktop is the same gesture as switching sessions.
 *
 * Kept as its own section rather than interleaved with local rows, because the
 * two have different operations: local rows rename/delete and steer a live
 * turn, remote rows archive/cancel and can only append to a gateway queue.
 * Merging them would make half the affordances conditional on a distinction the
 * user cannot see.
 *
 * Renders nothing at all when there are no remote conversations — a machine
 * that has never paired a phone should not grow an empty section, and a gateway
 * that is switched off surfaces its error on the settings page that owns it,
 * not here.
 */
function RemoteSection() {
  const t = useT();
  const acquire = useRemoteConversations((s) => s.acquire);
  const conversations = useRemoteConversations((s) => s.conversations);
  const selectedId = useRemoteConversations((s) => s.selectedId);
  const refresh = useRemoteConversations((s) => s.refresh);
  const [expanded, setExpanded] = useState(false);

  // Poll for as long as the sidebar is mounted; the store decides the cadence.
  useEffect(() => acquire(), [acquire]);

  const visible = useMemo(() => {
    if (expanded || conversations.length <= SESSION_COLLAPSE_THRESHOLD) {
      return conversations;
    }
    const head = conversations.slice(0, SESSION_COLLAPSE_THRESHOLD);
    if (selectedId && !head.some((c) => c.conversationId === selectedId)) {
      const active = conversations.find((c) => c.conversationId === selectedId);
      if (active) return [...head, active];
    }
    return head;
  }, [conversations, expanded, selectedId]);

  if (conversations.length === 0) return null;

  return (
    <>
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
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
          }}
        >
          <Smartphone size={11} />
          {t("sidebar.remote")}
        </span>
        <motion.button
          title={t("remoteTasks.refresh")}
          aria-label={t("remoteTasks.refresh")}
          onClick={() => void refresh()}
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
          <RefreshCw size={13} />
        </motion.button>
      </div>
      {visible.map((conversation) => (
        <RemoteRow
          key={conversation.conversationId}
          conversation={conversation}
          active={conversation.conversationId === selectedId}
        />
      ))}
      {conversations.length > SESSION_COLLAPSE_THRESHOLD && (
        <motion.button
          whileTap={{ scale: 0.97 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "calc(100% - 12px)",
            margin: "2px 6px",
            padding: "6px 10px",
            fontSize: 12,
            textAlign: "left",
            border: "none",
            borderRadius: 8,
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
          }}
        >
          <ChevronRight
            size={12}
            style={{
              display: "inline-block",
              transform: expanded ? "rotate(90deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          />
          <span>
            {expanded
              ? t("sidebar.collapseSessions")
              : t("sidebar.showAllRemote", { count: conversations.length })}
          </span>
        </motion.button>
      )}
    </>
  );
}

/** Status values that mean the host is mid-turn on this conversation. */
const REMOTE_BUSY_STATUSES = new Set(["queued", "starting", "running"]);

/**
 * One remote conversation row. Click focuses it on the chat surface. No rename
 * (the gateway derives titles) and no delete — archive is the remote-side
 * equivalent and lives in the panel header, where the conversation it applies
 * to is unambiguous.
 */
const RemoteRow = memo(function RemoteRow({
  conversation,
  active,
}: {
  conversation: RemoteConversationSnapshot;
  active: boolean;
}) {
  const t = useT();
  const select = useRemoteConversations((s) => s.select);
  const name = conversation.title?.trim() || t("remoteTasks.untitled");
  const awaiting = conversation.status === "awaiting_input";
  const busy = REMOTE_BUSY_STATUSES.has(conversation.status);
  const queued = conversation.queuedTurnCount;

  return (
    <div style={{ position: "relative" }}>
      <button
        className="pi-row"
        onClick={() => void select(conversation.conversationId)}
        title={name}
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
        <span style={{ opacity: 0.7, width: 15, display: "grid", placeItems: "center" }}>
          <Smartphone size={13} />
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            paddingRight: busy || awaiting ? 16 : 0,
          }}
        >
          {name}
          {queued > 0 && (
            <span style={{ opacity: 0.6, fontSize: 11 }}>
              {` · ${queued} ${t("remoteTasks.queued")}`}
            </span>
          )}
        </span>
      </button>
      {(busy || awaiting) && (
        <motion.span
          initial={{ opacity: 0.4 }}
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          title={t(`remoteTasks.status.${conversation.status}`)}
          style={{
            position: "absolute",
            right: 16,
            top: "50%",
            transform: "translateY(-50%)",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: awaiting ? "var(--warning)" : "var(--accent)",
            boxShadow: awaiting
              ? "0 0 0 2px color-mix(in srgb, var(--warning) 35%, transparent)"
              : "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
});

//─── SessionRow ───────────────────────────────────────────────────────────────

/**
 * One history row — click to load, double-click to rename inline,
 * hover reveals delete.
 */
const SessionRow = memo(function SessionRow({ s, active }: { s: ChatSessionMeta; active: boolean }) {
  // Select only the stable action references — avoids re-rendering every row
  // whenever the sessions store mutates (e.g. activeId / list changes).
  const switchSession = useSessions((st) => st.switchSession);
  const renameSession = useSessions((st) => st.renameSession);
  const deleteSession = useSessions((st) => st.deleteSession);
  // Running indicator: this conversation's own task is streaming (or its pi
  // process is mid-run), so a background task keeps showing a live dot even
  // when another session is focused. Color encodes attention state (running /
  // waiting-on-input / failed), mirroring the pet state machine.
  const taskStreaming = getChatStore(s.id)((st) => st.streaming);
  const taskRunning = getPiStore(s.id)((st) => st.status === "running");
  const taskWaiting = getChatStore(s.id)((st) => st.waiting);
  const taskFailed = getChatStore(s.id)((st) => {
    const last = st.messages[st.messages.length - 1];
    return last?.isError === true;
  });
  const taskState = taskFailed
    ? "failed"
    : taskWaiting
      ? "waiting"
      : taskStreaming || taskRunning
        ? "running"
        : "idle";
  const busy = taskState !== "idle";
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
        <span style={{ opacity: 0.7, fontSize: 13, width: 15, display: "grid", placeItems: "center" }}>
          <MessageSquare size={14} />
        </span>
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
      {busy && !editing && (
        <motion.span
          initial={{ opacity: 0.4 }}
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          title={t("agent.working")}
          style={{
            position: "absolute",
            right: hover ? 38 : 16,
            top: "50%",
            transform: "translateY(-50%)",
            width: 8,
            height: 8,
            borderRadius: "50%",
            background:
              taskState === "failed"
                ? "var(--danger)"
                : taskState === "waiting"
                  ? "var(--warning)"
                  : "var(--accent)",
            boxShadow:
              taskState === "waiting"
                ? "0 0 0 2px color-mix(in srgb, var(--warning) 35%, transparent)"
                : "0 0 0 2px color-mix(in srgb, var(--accent) 25%, transparent)",
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}, (prev, next) => prev.s === next.s && prev.active === next.active);

//─── TreeNode ─────────────────────────────────────────────────────────────────

/** Recursive tree row — Collapsible directories animate open, children lazy-load. */
function TreeNode({ entry, depth }: { entry: FsEntry; depth: number }) {
  const { expanded, entries, toggleDir, openFile } = useWorkspace();
  const {
    renamingPath, creatingIn, focusedEntry, setFocusedEntry,
    showCtxMenu, commitRename, cancelRename, commitCreate, cancelCreate,
  } = useContext(TreeEditCtx);
  const activeFile = useUI((s) => s.activeFile);
  const t = useT();

  const isOpen = !!expanded[entry.path];
  const children = entries[entry.path];
  const selected = !entry.isDir && activeFile === entry.path;
  const focused = focusedEntry?.path === entry.path;
  const isRenaming = renamingPath === entry.path;
  const myCreating = creatingIn?.dirPath === entry.path ? creatingIn : null;

  const rowButton = (
    <button
      onClick={() => {
        if (!isRenaming) {
          setFocusedEntry(entry);
          entry.isDir ? toggleDir(entry.path) : openFile(entry.path);
        }
      }}
      onContextMenu={(e) => showCtxMenu(e, entry)}
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
        outline: focused ? "1px solid var(--accent)" : "none",
        outlineOffset: -1,
        borderRadius: 7,
        cursor: "pointer",
        color: selected ? "var(--text-primary)" : "var(--text-secondary)",
        background: selected ? "var(--accent-muted)" : focused ? "var(--accent-muted)" : "transparent",
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

      {/* Inline rename: replace the label with a borderless input */}
      {isRenaming ? (
        <input
          autoFocus
          defaultValue={entry.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== entry.name) void commitRename(entry, v);
            else cancelRename();
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            const v = (e.target as HTMLInputElement).value.trim();
            if (e.key === "Enter") { if (v && v !== entry.name) void commitRename(entry, v); else cancelRename(); }
            if (e.key === "Escape") cancelRename();
          }}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12.5,
            border: "none",
            borderBottom: "1px solid var(--accent)",
            outline: "none",
            background: "transparent",
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
          }}
        />
      ) : (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entry.name}
        </span>
      )}
    </button>
  );

  if (!entry.isDir) return rowButton;

  return (
    <Collapsible open={isOpen} onOpenChange={() => toggleDir(entry.path)}>
      {rowButton}
      <CollapsibleContent>
        {/* Inline create row at the top of this directory's children */}
        {myCreating && isOpen && (
          <InlineInput
            placeholder={
              myCreating.type === "file"
                ? t("ctx.newFilePlaceholder")
                : t("ctx.newFolderPlaceholder")
            }
            onCommit={(name) => void commitCreate(entry.path, name, myCreating.type)}
            onCancel={cancelCreate}
            depth={depth + 1}
          />
        )}
        {(children ?? []).map((c) => (
          <TreeNode key={c.path} entry={c} depth={depth + 1} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
