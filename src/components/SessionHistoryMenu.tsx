"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@appica/ui-react/dropdown-menu";
import { useSessions, type ChatSessionMeta } from "@/lib/pi/sessions";
import { getChatStore } from "@/lib/pi/chat";
import { getPiStore } from "@/lib/pi/store";
import { useUI } from "@/lib/store";
import { useT, type TFunc } from "@/lib/i18n";
import { Check, History, PanelLeft, Trash2 } from "lucide-react";

/**
 * Session-history dropdown for the chat header.
 *
 * The header button used to only call `toggleSidebar()`, which is a no-op in
 * work mode (and zen mode): `showSidebar` there is `sidebarOpen && !zenMode &&
 * !workMode`, so the flag flipped and nothing rendered — the button read as
 * dead. History has to be reachable from the chat surface itself, so it lives
 * in a menu anchored to the button and works in every mode.
 *
 * Switching is the whole job here. Renaming stays in the sidebar (inline edit on
 * a row) — a menu that closes on click is the wrong surface for text entry.
 */
export function SessionHistoryMenu() {
  const sessions = useSessions((s) => s.sessions);
  const activeId = useSessions((s) => s.activeId);
  const t = useT();

  /* The store keeps this sorted on save, but a session that hasn't been saved
     since it was created can sit out of order — sort defensively so the newest
     conversation is always the first row. */
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <motion.button
            aria-label={t("agent.history")}
            title={t("agent.history")}
            whileTap={{ scale: 0.88 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            style={{
              display: "grid",
              placeItems: "center",
              width: 30,
              height: 30,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          />
        }
      >
        <History size={14} />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="material-thick"
        style={{
          minWidth: 260,
          maxWidth: 340,
          // Scrolls rather than capping the list: in work mode this menu is the
          // only way to reach an older conversation, so every row has to be
          // reachable from here.
          maxHeight: 360,
          overflowY: "auto",
          padding: 6,
          border: "1px solid var(--separator)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 60,
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel
            style={{
              padding: "6px 10px 3px",
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
            }}
          >
            {t("agent.history")}
          </DropdownMenuGroupLabel>

          {ordered.length === 0 ? (
            <div
              style={{
                padding: "10px 12px",
                fontSize: 12,
                color: "var(--text-tertiary)",
              }}
            >
              {t("history.empty")}
            </div>
          ) : (
            ordered.map((s) => (
              <HistoryRow key={s.id} s={s} active={s.id === activeId} />
            ))
          )}
        </DropdownMenuGroup>

        <SidebarFooterItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Open the sidebar" tail — rename, the file tree and the phone-started
 * conversations all live there. Hidden in the layouts that can't render a
 * sidebar, so the menu never offers an action that does nothing.
 */
function SidebarFooterItem() {
  const workMode = useUI((s) => s.workMode);
  const zenMode = useUI((s) => s.zenMode);
  const layoutMode = useUI((s) => s.layoutMode);
  const t = useT();
  /* mirrors showSidebar in page.tsx (and the toggle's gate in TopBar): work-only
     keeps the sidebar because it has no way back to the IDE, plain work mode
     hides it, and zen mode shows nothing but the composer. */
  const sidebarReachable = !zenMode && (!workMode || layoutMode === "work-only");
  if (!sidebarReachable) return null;

  return (
    <>
      <DropdownMenuSeparator
        style={{ height: 1, margin: "5px 4px", background: "var(--separator)" }}
      />
      <DropdownMenuItem
        onClick={() => {
          if (!useUI.getState().sidebarOpen) useUI.getState().toggleSidebar();
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "7px 10px",
          borderRadius: 8,
          fontSize: 12.5,
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        <PanelLeft size={13} style={{ opacity: 0.7, flexShrink: 0 }} />
        {t("history.openSidebar")}
      </DropdownMenuItem>
    </>
  );
}

/**
 * One conversation. Mirrors SessionRow's live dot so a background task that is
 * running, waiting on input or failed is visible without switching to it.
 */
function HistoryRow({ s, active }: { s: ChatSessionMeta; active: boolean }) {
  const switchSession = useSessions((st) => st.switchSession);
  const deleteSession = useSessions((st) => st.deleteSession);
  const streaming = getChatStore(s.id)((st) => st.streaming);
  const waiting = getChatStore(s.id)((st) => st.waiting);
  const running = getPiStore(s.id)((st) => st.status === "running");
  const failed = getChatStore(s.id)((st) => {
    const last = st.messages[st.messages.length - 1];
    return last?.isError === true;
  });
  const t = useT();

  const name = s.name.trim() || t("session.untitled");
  const dot = failed
    ? "var(--danger)"
    : waiting
      ? "var(--warning)"
      : streaming || running
        ? "var(--accent)"
        : null;

  return (
    <DropdownMenuItem
      onClick={() => void switchSession(s.id)}
      title={s.preview || name}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "7px 10px",
        borderRadius: 8,
        fontSize: 12.5,
        color: "var(--text-primary)",
        cursor: "pointer",
      }}
    >
      {dot ? (
        <motion.span
          initial={{ opacity: 0.4 }}
          animate={{ opacity: [0.4, 1, 0.4] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flexShrink: 0,
            background: dot,
          }}
        />
      ) : (
        <span style={{ width: 7, flexShrink: 0 }} />
      )}

      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: active ? 600 : 400,
        }}
      >
        {name}
      </span>

      <span
        style={{
          fontSize: 10.5,
          color: "var(--text-tertiary)",
          flexShrink: 0,
        }}
      >
        {relativeTime(s.updatedAt, t)}
      </span>

      {active ? (
        <span style={{ display: "inline-flex", color: "var(--accent)", flexShrink: 0 }}>
          <Check size={13} />
        </span>
      ) : (
        /* Base UI activates a menu item from the DOM click on the item element,
           and emits its own `close` from the same handler — so stopping this
           click does both jobs at once: the row can't switch to the conversation
           being deleted, and the menu stays open for the next delete. Mouse-only
           by design (tabIndex -1): a focusable control inside a menuitem breaks
           the menu's own arrow-key navigation. */
        <motion.span
          role="button"
          tabIndex={-1}
          aria-label={t("session.delete")}
          title={t("session.delete")}
          whileTap={{ scale: 0.85 }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            void deleteSession(s.id);
          }}
          style={{
            display: "grid",
            placeItems: "center",
            width: 18,
            height: 18,
            borderRadius: 4,
            flexShrink: 0,
            color: "var(--text-tertiary)",
            cursor: "pointer",
          }}
        >
          <Trash2 size={12} />
        </motion.span>
      )}
    </DropdownMenuItem>
  );
}

/** Compact "when was this last touched" stamp. */
function relativeTime(at: number, t: TFunc): string {
  const min = Math.floor((Date.now() - at) / 60_000);
  if (min < 1) return t("history.justNow");
  if (min < 60) return t("history.minutesAgo", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("history.hoursAgo", { n: hr });
  const day = Math.floor(hr / 24);
  return t("history.daysAgo", { n: day });
}
