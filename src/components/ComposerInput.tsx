"use client";

import { useRef, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Square, ArrowUp, X, Zap, ListPlus, FileText, Maximize2 } from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import { ThinkingPicker } from "./ThinkingPicker";
import { ImageLightbox } from "./ImageLightbox";
import { LongTextModal } from "./LongTextModal";
import { FileMentionMenu, type MentionStatus } from "./FileMentionMenu";
import type { DeliveryMode, QueueEntry } from "@/lib/pi/chat";
import { useT } from "@/lib/i18n";
import { isLongText, longTextStats } from "@/lib/long-text";
import { useUI } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { MENTION_RESULT_LIMIT, useFileIndex } from "@/lib/file-index";
import {
  buildMentionValue,
  isDirectoryPath,
  mentionTokenAt,
  rankPaths,
} from "@/lib/file-match";
import { composerBus } from "@/lib/composer-bus";
import { formatSendShortcut, matchSendIntent } from "@/lib/composer-shortcut";

interface ComposerInputProps {
  draft: string;
  setDraft: (value: string) => void;
  longTextDraft: string | null;
  setLongTextDraft: (value: string | null) => void;
  attachments: string[];
  setAttachments: (value: string[]) => void;
  streaming: boolean;
  /** true while an auto-retry is in flight — also surfaces the Stop button */
  retrying?: boolean;
  busy: boolean;
  /** `alt` swaps steer/queue for this one send (⌘⇧⏎) */
  onSubmit: (alt?: boolean) => void;
  onAbort: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  /** messages already handed to pi that it has not consumed yet */
  queue: QueueEntry[];
  /** how ⌘⏎ delivers while a turn is running */
  delivery: DeliveryMode;
  onDeliveryChange: (mode: DeliveryMode) => void;
  /**
   * Drops the top rule. That border divides the transcript from a composer
   * docked at the bottom; in the welcome state the composer floats at the
   * centerline with the brand above it, where the same line reads as a stray
   * rule severing the two.
   */
  seamless?: boolean;
}

/**
 * Elegant multi-line composer with embedded model picker.
 * Warm cream background, compact auto-growing textarea, and a large modal editor
 * follows the user's `sendShortcut` preference (⌘↩ by default).
 */
export function ComposerInput({
  draft,
  setDraft,
  longTextDraft,
  setLongTextDraft,
  attachments,
  setAttachments,
  streaming,
  retrying = false,
  busy,
  onSubmit,
  onAbort,
  onKeyDown,
  onPaste,
  queue,
  delivery,
  onDeliveryChange,
  seamless = false,
}: ComposerInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const t = useT();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<"document" | "instruction" | null>(null);
  const [textareaOverflowing, setTextareaOverflowing] = useState(false);
  const sendShortcut = useUI((s) => s.sendShortcut);
  // Resolved after mount on purpose: the static export prerenders without a
  // navigator, so reading it during render would mismatch on hydration.
  const [isMac, setIsMac] = useState(false);
  const steerCount = queue.filter((q) => q.kind === "steer").length;
  const queuedCount = queue.filter((q) => q.kind === "followUp").length;
  const showLongEditor = Boolean(draft.trim()) && (isLongText(draft) || textareaOverflowing);
  const hasLongTextDraft = Boolean(longTextDraft?.trim());
  const canSend = Boolean(draft.trim() || hasLongTextDraft || attachments.length > 0);
  const documentStats = longTextDraft !== null ? longTextStats(longTextDraft) : null;

  /* ── @-mention completion ──────────────────────────────────────────────────
     Caret-based, unlike the slash menu: `@` can open a token anywhere in the
     sentence, so the draft alone does not say which one is being typed. That is
     the only reason the caret is state here. */
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const root = useWorkspace((s) => s.root);
  const workspaceTarget = useWorkspace((s) => s.targetId);
  const indexPaths = useFileIndex((s) => s.paths);
  const indexLoading = useFileIndex((s) => s.loading);
  const indexUnsupported = useFileIndex((s) => s.unsupported);
  const indexTruncated = useFileIndex((s) => s.truncated);

  /* The two menus are mutually exclusive by construction — a slash query holds no
     spaces, and any query containing `@` matches no command name — but saying so
     here makes it structural instead of an argument, and costs only the
     pathological `/a=@b` case. Without it both would claim Enter. */
  const slashPrefixActive = draft.startsWith("/") && !draft.includes(" ");
  const mentionToken =
    mentionDismissed || slashPrefixActive ? null : mentionTokenAt(draft, caret);
  const mentionQuery = mentionToken?.query ?? null;

  /* Walk the project the first time a mention is actually typed. Doing it at
     project-open time would put a filesystem traversal on the startup path. */
  useEffect(() => {
    if (mentionQuery === null) return;
    useFileIndex.getState().ensure(root, workspaceTarget);
  }, [mentionQuery, root, workspaceTarget]);

  const mentionItems = useMemo(
    () => (mentionQuery === null ? [] : rankPaths(mentionQuery, indexPaths, MENTION_RESULT_LIMIT)),
    [mentionQuery, indexPaths]
  );
  const mentionOpen = mentionToken !== null;
  /* A stale list being refreshed behind the scenes still has rows, so `ready`
     wins over `loading` — the menu must not blink back to a spinner mid-typing. */
  const mentionStatus: MentionStatus = indexUnsupported
    ? "unsupported"
    : mentionItems.length > 0
      ? "ready"
      : indexLoading
        ? "loading"
        : "empty";

  useEffect(() => setMentionIndex(0), [mentionQuery]);

  /**
   * Replace the token under the caret with `path`.
   *
   * A directory keeps its trailing slash, gets no closing space and leaves the menu
   * open: picking `src/lib/` is the user drilling down, not finishing a mention.
   */
  const pickMention = (path: string) => {
    if (!mentionToken) return;
    const isDir = isDirectoryPath(path);
    const value = buildMentionValue(path, { quoted: mentionToken.quoted, open: isDir });
    const before = draft.slice(0, mentionToken.start);
    const after = draft.slice(mentionToken.end);
    const gap = isDir || after.startsWith(" ") ? "" : " ";
    const nextCaret = before.length + value.length + gap.length;
    setDraft(before + value + gap + after);
    setCaret(nextCaret);
    setMentionDismissed(false);
    /* One frame later: React writes the new `value` onto the textarea when it
       commits, and a selection set before that write is discarded with it. */
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
    });
  };

  /* Insertions from outside the composer (the file tree's context menu). Held in
     refs so the subscription survives every keystroke instead of being torn down
     and re-established — same reason `useFileDropZone` keeps its handler in one. */
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const caretRef = useRef(caret);
  caretRef.current = caret;
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;

  useEffect(
    () =>
      composerBus.subscribe(({ text }) => {
        const current = draftRef.current;
        const at = Math.min(caretRef.current, current.length);
        const before = current.slice(0, at);
        const after = current.slice(at);
        // Separated from whatever it lands next to: dropped straight against the
        // previous word, the mention would parse as part of that token.
        const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
        const trail = after.startsWith(" ") ? "" : " ";
        const nextCaret = before.length + lead.length + text.length + trail.length;
        setDraftRef.current(before + lead + text + trail + after);
        setCaret(nextCaret);
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.focus();
          textarea.setSelectionRange(nextCaret, nextCaret);
        });
      }),
    []
  );

  // Keep the docked composer compact. Once content needs more room, the modal
  // becomes the comfortable reading/editing surface without reflowing the chat.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const lineHeight = 20;
    const verticalPadding = 54; // 14px top + 40px bottom (matches textarea style)
    textarea.style.height = "auto";
    const measuredLines = Math.max(
      2,
      Math.ceil((textarea.scrollHeight - verticalPadding) / lineHeight)
    );
    const visibleLines = Math.min(6, measuredLines);
    textarea.style.height = `${visibleLines * lineHeight + verticalPadding}px`;
    setTextareaOverflowing(measuredLines > visibleLines);
  }, [draft]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
    setIsMac(/mac/i.test(navigator.platform || navigator.userAgent));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /* Mention menu first, before the parent's slash handling and before the send
       shortcut. It only claims keys while it has rows to offer — showing "no
       matching files" must not also swallow the Enter that sends the message. */
    if (mentionOpen) {
      if (e.key === "Escape") {
        setMentionDismissed(true);
        return;
      }
      if (mentionItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => (i + 1) % mentionItems.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
          return;
        }
        // ⌘/Ctrl+↩ still sends, as with the slash menu: only the plain Enter
        // family is claimed, so an Enter-to-send preference does not steal the pick.
        if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
          e.preventDefault();
          pickMention(mentionItems[mentionIndex] ?? mentionItems[0]);
          return;
        }
      }
    }

    // Parent next: with the ↩ preference the slash menu is bound to the same
    // key we send on, and picking a command has to win over sending. It signals
    // that it consumed the key by calling preventDefault().
    onKeyDown(e);
    if (e.defaultPrevented) return;

    const intent = matchSendIntent(e, sendShortcut);
    if (!intent) return; // e.g. a bare ↩ under ⌘↩ — let it insert a newline
    e.preventDefault();
    onSubmit(intent === "altSend"); // altSend flips steer↔queue for this send
  };

  /** Caret moves that no `onChange` reports: arrows, clicks, drag-selection. */
  const syncCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCaret(e.currentTarget.selectionStart ?? 0);
  };

  return (
    <div
      style={{
        padding: 12,
        borderTop: seamless ? "none" : "1px solid var(--separator)",
        position: "relative",
      }}
    >
      {/* "@" surfaces project files. Rendered here rather than beside the slash
          menu in AgentPanel because picking a row edits at the caret, which only
          this component can read. */}
      <FileMentionMenu
        open={mentionOpen}
        items={mentionItems}
        activeIndex={mentionIndex}
        status={mentionStatus}
        truncated={indexTruncated}
        onHover={setMentionIndex}
        onSelect={pickMention}
      />

      {/* Pending-with-pi chip. Informational on purpose: the RPC protocol has no
          un-queue command, so the only way to drop these is Stop (abort). */}
      {queue.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 400, damping: 26 }}
          title={queue.map((q) => q.text).filter(Boolean).join("\n") || undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 12px",
            marginBottom: 8,
            borderRadius: 8,
            background: "var(--bg-base)",
            border: "1px solid var(--separator)",
            fontSize: 12,
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            {[
              steerCount > 0 ? t("queue.steering", { count: steerCount }) : "",
              queuedCount > 0 ? t("queue.followUp", { count: queuedCount }) : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span style={{ fontSize: 10.5, color: "var(--text-tertiary)" }}>
            {t("queue.pendingHint")}
          </span>
        </motion.div>
      )}

      {/* Pasted-image tray */}
      {attachments.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 8,
          }}
        >
          {attachments.map((src, i) => (
            <motion.div
              key={`${i}-${src.slice(-16)}`}
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 26 }}
              style={{ position: "relative" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={src}
                alt={t("agent.pastedImage")}
                title={t("agent.viewImage")}
                onClick={() => setPreviewSrc(src)}
                style={{
                  width: 52,
                  height: 52,
                  objectFit: "cover",
                  borderRadius: 10,
                  border: "1px solid var(--separator)",
                  display: "block",
                  cursor: "zoom-in",
                }}
              />
              <button
                onClick={() =>
                  setAttachments(attachments.filter((_, j) => j !== i))
                }
                aria-label={t("agent.removeImage")}
                style={{
                  position: "absolute",
                  top: -5,
                  right: -5,
                  width: 16,
                  height: 16,
                  borderRadius: 99,
                  border: "1px solid var(--separator)",
                  background: "var(--bg-base)",
                  color: "var(--text-secondary)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <X size={10} />
              </button>
            </motion.div>
          ))}
        </div>
      )}

      {longTextDraft !== null && documentStats && (
        <div
          style={{
            height: 40,
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            padding: "0 8px 0 11px",
            border: "1px solid var(--separator)",
            borderRadius: 11,
            background: "var(--bg-elevated)",
            color: "var(--text-primary)",
          }}
        >
          <FileText size={14} style={{ flex: "0 0 auto", color: "var(--accent)" }} />
          <button
            type="button"
            onClick={() => setEditorTarget("document")}
            aria-label={t("longText.openEditor")}
            title={t("longText.openEditor")}
            style={{
              minWidth: 0,
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 7,
              overflow: "hidden",
              border: "none",
              padding: 0,
              background: "transparent",
              color: "inherit",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span style={{ flex: "0 0 auto", fontSize: 12, fontWeight: 600 }}>
              {t("longText.draftReference")}
            </span>
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                color: "var(--text-tertiary)",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {t("longText.stats", {
                characters: String(documentStats.characters),
                lines: String(documentStats.lines),
              })}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setLongTextDraft(null)}
            aria-label={t("longText.remove")}
            title={t("longText.remove")}
            style={{
              width: 26,
              height: 26,
              flex: "0 0 auto",
              display: "grid",
              placeItems: "center",
              border: "none",
              borderRadius: 7,
              padding: 0,
              background: "transparent",
              color: "var(--text-tertiary)",
              cursor: "pointer",
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Main composer container — elevated surface with subtle shadow */}
      <div
        style={{
          position: "relative",
          borderRadius: 16,
          background: "var(--bg-elevated)",
          border: "1px solid var(--separator)",
          boxShadow: "0 2px 8px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04)",
          transition: "box-shadow 0.2s ease, border-color 0.2s ease",
        }}
        onFocus={(e) => {
          if (e.currentTarget.contains(e.target as Node)) {
            e.currentTarget.style.boxShadow =
              "0 3px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.06)";
            e.currentTarget.style.borderColor = "var(--accent)";
          }
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            e.currentTarget.style.boxShadow =
              "0 2px 8px rgba(0, 0, 0, 0.06), 0 1px 3px rgba(0, 0, 0, 0.04)";
            e.currentTarget.style.borderColor = "var(--separator)";
          }
        }}
      >
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setMentionDismissed(false); // typing re-opens an escaped menu
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onPaste={onPaste}
          placeholder={
            streaming
              ? t(delivery === "steer" ? "agent.composerSteer" : "agent.composerQueue")
              : busy
                ? t("agent.composerBusy")
                : t("agent.composerIdle")
          }
          rows={2}
          className="composer-textarea"
          style={{
            width: "100%",
            // room for the send button, plus Stop next to it while streaming
            padding: `14px ${(streaming || retrying ? 90 : 52) + (showLongEditor ? 38 : 0)}px 40px 14px`,
            border: "none",
            outline: "none",
            background: "transparent",
            borderRadius: 16,
            fontSize: 13.5,
            lineHeight: "20px",
            color: "var(--text-primary)",
            fontFamily: "var(--font-ui)",
            resize: "none",
          }}
        />

        {/* Send / Stop buttons — top right. While a turn is running both are
            present: the left one delivers into the run, Stop kills it. */}
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {showLongEditor && (
            <motion.button
              type="button"
              onClick={() => setEditorTarget("instruction")}
              whileTap={{ scale: 0.94 }}
              aria-label={t("longText.openEditor")}
              title={t("longText.openEditor")}
              style={{
                width: 32,
                height: 32,
                border: "1px solid var(--separator)",
                borderRadius: 8,
                background: "var(--bg-base)",
                color: "var(--text-secondary)",
                cursor: "pointer",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Maximize2 size={14} />
            </motion.button>
          )}
          {(streaming || retrying) && canSend && (
            <motion.button
              onClick={() => onSubmit()}
              whileTap={{ scale: 0.9 }}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              title={t(
                delivery === "steer" ? "composer.deliverySteer" : "composer.deliveryQueue"
              )}
              aria-label={t(
                delivery === "steer" ? "composer.deliverySteer" : "composer.deliveryQueue"
              )}
              style={{
                width: 32,
                height: 32,
                border: "none",
                borderRadius: 8,
                background: "var(--accent)",
                color: "#FFFFFF",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {delivery === "steer" ? <Zap size={14} /> : <ListPlus size={14} />}
            </motion.button>
          )}
          {streaming || retrying ? (
            <motion.button
              onClick={onAbort}
              whileTap={{ scale: 0.9 }}
              title={t("agent.stop")}
              style={{
                width: 32,
                height: 32,
                border: "none",
                borderRadius: 8,
                background: "var(--accent-muted)",
                color: "var(--accent)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "opacity 0.2s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "0.8";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "1";
              }}
            >
              <Square size={14} />
            </motion.button>
          ) : (
            <motion.button
              onClick={() => onSubmit()}
              whileTap={{ scale: 0.9 }}
              aria-label={t("agent.send")}
              disabled={!canSend}
              style={{
                width: 32,
                height: 32,
                border: "none",
                borderRadius: 8,
                background: canSend ? "var(--accent)" : "var(--separator)",
                color: "#FFFFFF",
                cursor: canSend ? "pointer" : "not-allowed",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.2s ease, transform 0.1s ease",
              }}
              onMouseEnter={(e) => {
                if (canSend) {
                  e.currentTarget.style.background = "var(--accent-hover)";
                }
              }}
              onMouseLeave={(e) => {
                if (canSend) {
                  e.currentTarget.style.background = "var(--accent)";
                }
              }}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </motion.button>
          )}
        </div>

        {/* Bottom controls — model + thinking pickers (left), delivery mode /
            char count (right). The row does not wrap (it is anchored to the
            composer's bottom edge), so the left cluster absorbs any squeeze by
            truncating the model name rather than overflowing the send button. */}
        <div
          style={{
            position: "absolute",
            bottom: 10,
            left: 10,
            right: 52,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* model + thinking level read as one control cluster; both are live
              per-session switches that used to require a trip to Settings */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <ModelPicker compact />
            <ThinkingPicker compact />
          </div>
          {streaming ? (
            <div
              title={t("composer.deliveryHint")}
              style={{
                display: "flex",
                gap: 2,
                padding: 2,
                borderRadius: 7,
                background: "var(--bg-base)",
                border: "1px solid var(--separator)",
              }}
            >
              {(["steer", "followUp"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => onDeliveryChange(mode)}
                  style={{
                    border: "none",
                    borderRadius: 5,
                    padding: "2px 7px",
                    fontSize: 10.5,
                    cursor: "pointer",
                    background: delivery === mode ? "var(--accent)" : "transparent",
                    color:
                      delivery === mode ? "#FFFFFF" : "var(--text-tertiary)",
                    transition: "background 0.15s ease, color 0.15s ease",
                  }}
                >
                  {t(
                    mode === "steer"
                      ? "composer.deliverySteer"
                      : "composer.deliveryQueue"
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div
              style={{
                fontSize: 10.5,
                color: "var(--text-tertiary)",
                fontFamily: "var(--font-mono)",
                opacity: draft.length > 100 ? 1 : 0,
                transition: "opacity 0.2s ease",
              }}
            >
              {draft.length > 0 && `${draft.length} chars`}
            </div>
          )}
        </div>

        {/* Keyboard hint — bottom right corner, very subtle */}
        <div
          style={{
            position: "absolute",
            bottom: 10,
            right: 14,
            fontSize: 9.5,
            color: "var(--text-tertiary)",
            opacity: 0.6,
            fontFamily: "var(--font-mono)",
            pointerEvents: "none",
          }}
        >
          {formatSendShortcut(sendShortcut, isMac)}
        </div>
      </div>

      <LongTextModal
        open={editorTarget !== null}
        value={editorTarget === "document" ? longTextDraft ?? "" : draft}
        mode="edit"
        onChange={(value) => {
          if (editorTarget === "document") setLongTextDraft(value);
          else setDraft(value);
        }}
        onClose={() => {
          if (editorTarget === "document" && !longTextDraft?.trim()) setLongTextDraft(null);
          setEditorTarget(null);
          requestAnimationFrame(() => textareaRef.current?.focus());
        }}
      />

      {/* Click-to-zoom lightbox for attachment previews */}
      <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
