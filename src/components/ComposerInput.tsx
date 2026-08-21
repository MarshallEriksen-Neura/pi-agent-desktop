"use client";

import { useRef, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Square, ArrowUp, X, Zap, ListPlus } from "lucide-react";
import { ModelPicker } from "./ModelPicker";
import { ImageLightbox } from "./ImageLightbox";
import type { DeliveryMode, QueueEntry } from "@/lib/pi/chat";
import { useT } from "@/lib/i18n";
import { useUI } from "@/lib/store";
import { formatSendShortcut, matchSendIntent } from "@/lib/composer-shortcut";

interface ComposerInputProps {
  draft: string;
  setDraft: (value: string) => void;
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
}

/**
 * Elegant multi-line composer with embedded model picker.
 * Warm cream background, auto-expanding textarea (2-12 lines). The send key
 * follows the user's `sendShortcut` preference (⌘↩ by default).
 */
export function ComposerInput({
  draft,
  setDraft,
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
}: ComposerInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const t = useT();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const sendShortcut = useUI((s) => s.sendShortcut);
  // Resolved after mount on purpose: the static export prerenders without a
  // navigator, so reading it during render would mismatch on hydration.
  const [isMac, setIsMac] = useState(false);
  const steerCount = queue.filter((q) => q.kind === "steer").length;
  const queuedCount = queue.filter((q) => q.kind === "followUp").length;

  // Auto-resize textarea based on content (2-12 lines).
  // scrollHeight includes the vertical padding (14 top + 40 bottom), so it
  // must be subtracted before converting to a line count.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const lineHeight = 20;
    const verticalPadding = 54; // 14px top + 40px bottom (matches textarea style)
    textarea.style.height = "auto";
    const lines = Math.min(
      12,
      Math.max(2, Math.round((textarea.scrollHeight - verticalPadding) / lineHeight))
    );
    textarea.style.height = `${lines * lineHeight + verticalPadding}px`;
  }, [draft]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
    setIsMac(/mac/i.test(navigator.platform || navigator.userAgent));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Parent first: with the ↩ preference the slash menu is bound to the same
    // key we send on, and picking a command has to win over sending. It signals
    // that it consumed the key by calling preventDefault().
    onKeyDown(e);
    if (e.defaultPrevented) return;

    const intent = matchSendIntent(e, sendShortcut);
    if (!intent) return; // e.g. a bare ↩ under ⌘↩ — let it insert a newline
    e.preventDefault();
    onSubmit(intent === "altSend"); // altSend flips steer↔queue for this send
  };

  return (
    <div
      style={{
        padding: 12,
        borderTop: "1px solid var(--separator)",
        position: "relative",
      }}
    >
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
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
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
            padding: `14px ${streaming || retrying ? 90 : 52}px 40px 14px`,
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
          {(streaming || retrying) && (draft.trim() || attachments.length > 0) && (
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
              disabled={!draft.trim() && attachments.length === 0}
              style={{
                width: 32,
                height: 32,
                border: "none",
                borderRadius: 8,
                background:
                  draft.trim() || attachments.length > 0
                    ? "var(--accent)"
                    : "var(--separator)",
                color: "#FFFFFF",
                cursor:
                  draft.trim() || attachments.length > 0 ? "pointer" : "not-allowed",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.2s ease, transform 0.1s ease",
              }}
              onMouseEnter={(e) => {
                if (draft.trim() || attachments.length > 0) {
                  e.currentTarget.style.background = "var(--accent-hover)";
                }
              }}
              onMouseLeave={(e) => {
                if (draft.trim() || attachments.length > 0) {
                  e.currentTarget.style.background = "var(--accent)";
                }
              }}
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </motion.button>
          )}
        </div>

        {/* Bottom controls — model picker (left) + delivery mode / char count (right) */}
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
          <ModelPicker compact />
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

      {/* Click-to-zoom lightbox for attachment previews */}
      <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
    </div>
  );
}
