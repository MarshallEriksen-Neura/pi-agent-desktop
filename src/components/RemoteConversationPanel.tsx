"use client";

import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Archive, Ban, Send, Smartphone, WifiOff, X } from "lucide-react";
import type { RemoteMessage } from "@pi/remote-control-contracts";
import { useRemoteConversations } from "@/lib/remote-conversations/store";
import { useT } from "@/lib/i18n";
import { AGENT_PANEL_WIDTH_DEFAULT } from "@/lib/store";
import type { ChatMessage } from "@/lib/pi/chat";
import { MessageBubble } from "./MessageBubble";
import { IconButton, SectionLabel } from "./primitives";

/**
 * The chat surface for a conversation started on a paired phone.
 *
 * Replaces the agent panel's local stream while a remote conversation is
 * focused, so continuing a phone conversation on the desktop is the same
 * gesture as switching sessions — pick it in the sidebar, type, send.
 *
 * Deliberately not the local composer. Remote turns are append-only against a
 * gateway queue (one turn runs globally at a time), so there is no steer /
 * follow-up choice to offer, no image attachments, and no slash commands — the
 * gateway runs pi with extensions and skills disabled. Offering that chrome
 * would advertise capabilities the remote path does not have.
 */
export function RemoteConversationPanel({ width }: { width?: number } = {}) {
  const t = useT();
  const selected = useRemoteConversations((s) => s.selected);
  const messages = useRemoteConversations((s) => s.messages);
  const error = useRemoteConversations((s) => s.error);
  const sending = useRemoteConversations((s) => s.sending);
  const append = useRemoteConversations((s) => s.append);
  const cancelActive = useRemoteConversations((s) => s.cancelActive);
  const archive = useRemoteConversations((s) => s.archive);
  const deselect = useRemoteConversations((s) => s.deselect);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const archived = selected?.status === "archived";
  const canSend = !!selected && !archived && !sending;
  const modelRef =
    selected?.activeTurn?.modelRef ??
    selected?.latestTurn?.modelRef ??
    selected?.defaultModelRef;

  /* Remote transcripts carry text only: tool calls and thinking live in the
     gateway's event stream and never reach the persisted message rows. Map to
     the local shape anyway so bubbles, markdown and code blocks look the same
     on both surfaces — the empty tools/thinking fields simply render nothing. */
  const bubbles = useMemo<ChatMessage[]>(
    () => messages.map(toChatMessage),
    [messages],
  );

  const submit = () => {
    const prompt = draft.trim();
    if (!canSend || !prompt) return;
    setDraft("");
    void append(prompt).then((ok) => {
      if (!ok) setDraft(prompt); // keep the text so the send can be retried
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    });
  };

  return (
    <aside
      className="material"
      style={{
        // matches the local panel: the rail's dragged width, or the stock rail
        width: width ?? AGENT_PANEL_WIDTH_DEFAULT,
        height: "100%",
        borderLeft: "1px solid var(--separator)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
      }}
    >
      {/* header — device provenance + per-conversation actions */}
      <div style={{ display: "flex", alignItems: "center", paddingRight: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Smartphone size={11} />
              {t("remoteTasks.title")}
            </span>
          </SectionLabel>
        </div>
        <div style={{ display: "flex", alignItems: "center", paddingTop: 8 }}>
          {selected?.activeTurn && (
            <IconButton label={t("remoteTasks.cancel")} onClick={() => void cancelActive()}>
              <Ban size={14} />
            </IconButton>
          )}
          {selected && (
            <IconButton
              label={t("remoteTasks.archive")}
              onClick={() => void archive(selected.conversationId)}
            >
              <Archive size={14} />
            </IconButton>
          )}
          <IconButton label={t("remoteTasks.backToLocal")} onClick={deselect}>
            <X size={14} />
          </IconButton>
        </div>
      </div>

      {/* conversation meta — status, device, model */}
      <div style={{ padding: "0 12px 8px" }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={selected?.title || t("remoteTasks.untitled")}
        >
          {selected?.title || t("remoteTasks.untitled")}
        </div>
        {selected && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginTop: 4,
              fontSize: 11,
              color: "var(--text-tertiary)",
            }}
          >
            <span>{t(`remoteTasks.status.${selected.status}`)}</span>
            <span title={selected.ownerDeviceId}>{t("remoteTasks.fromPhone")}</span>
            <span title={modelRef ?? undefined}>{modelRef ?? t("remoteTasks.modelUnset")}</span>
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            margin: "0 12px 8px",
            padding: "7px 9px",
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
            background: "color-mix(in srgb, var(--danger) 8%, transparent)",
            color: "var(--danger)",
            fontSize: 12,
          }}
        >
          <WifiOff size={13} style={{ flexShrink: 0 }} />
          <span style={{ minWidth: 0, wordBreak: "break-word" }}>{error}</span>
        </div>
      )}

      {/* transcript — plain scroller, not virtualized: the gateway caps a page
          at 100 messages, well under the count that needs windowing. */}
      <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px" }}>
        {!selected && !error && (
          <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", padding: "10px 2px" }}>
            {t("common.loading")}
          </p>
        )}
        {selected && bubbles.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--text-tertiary)", padding: "10px 2px" }}>
            {t("remoteTasks.waiting")}
          </p>
        )}
        {bubbles.map((m, i) => (
          <div key={m.id} style={{ display: "flow-root" }}>
            <MessageBubble m={m} animateIn={i === bubbles.length - 1} />
          </div>
        ))}
        {/* Fidelity is a real difference, not a bug — say so once, at the end of
            the transcript, instead of letting missing tool cards read as broken. */}
        {selected && bubbles.length > 0 && (
          <p
            style={{
              fontSize: 11,
              color: "var(--text-tertiary)",
              padding: "8px 2px 12px",
              lineHeight: 1.5,
            }}
          >
            {t("remoteTasks.textOnlyNote")}
          </p>
        )}
      </div>

      {/* composer — append-only; queues behind a running turn */}
      <div style={{ padding: "8px 12px 12px" }}>
        {archived ? (
          <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: 0 }}>
            {t("remoteTasks.archivedNote")}
          </p>
        ) : (
          <>
            {selected?.activeTurn && (
              <p
                style={{
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                  margin: "0 0 6px",
                  lineHeight: 1.5,
                }}
              >
                {t("remoteTasks.busyNote")}
              </p>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
              style={{ display: "flex", alignItems: "flex-end", gap: 7 }}
            >
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={t("remoteTasks.followUpPlaceholder")}
                rows={2}
                disabled={!selected}
                style={{
                  flex: 1,
                  minWidth: 0,
                  resize: "none",
                  border: "1px solid var(--separator)",
                  borderRadius: 10,
                  background: "var(--bg-elevated, var(--material-thick))",
                  color: "var(--text-primary)",
                  padding: "8px 10px",
                  fontSize: 13,
                  fontFamily: "var(--font-ui)",
                  outline: "none",
                }}
              />
              <motion.button
                type="submit"
                whileTap={{ scale: 0.9 }}
                transition={{ type: "spring", stiffness: 500, damping: 24 }}
                disabled={!canSend || !draft.trim()}
                title={sending ? t("remoteTasks.sending") : t("remoteTasks.send")}
                aria-label={t("remoteTasks.send")}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 34,
                  height: 34,
                  flexShrink: 0,
                  border: 0,
                  borderRadius: 10,
                  background: "var(--accent)",
                  color: "#fff",
                  cursor: canSend && draft.trim() ? "pointer" : "not-allowed",
                  opacity: canSend && draft.trim() ? 1 : 0.4,
                }}
              >
                <Send size={15} />
              </motion.button>
            </form>
          </>
        )}
      </div>
    </aside>
  );
}

/** Project a gateway message row onto the local bubble shape. */
function toChatMessage(message: RemoteMessage): ChatMessage {
  const failed = message.status === "failed";
  return {
    id: message.messageId,
    // "system" rows are gateway notices; render them in the assistant lane
    // rather than adding a third bubble style for a rare case.
    role: message.role === "user" ? "user" : "assistant",
    text: message.text,
    thinking: "",
    tools: [],
    streaming: message.status === "streaming",
    isError: failed || undefined,
    errorText: failed ? message.error?.message : undefined,
  };
}
