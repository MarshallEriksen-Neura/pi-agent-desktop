"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Check, Copy, FileText, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { longTextStats } from "@/lib/long-text";
import { copyText } from "@/lib/terminal-clipboard";

interface LongTextModalProps {
  open: boolean;
  value: string;
  mode: "edit" | "view";
  onChange?: (value: string) => void;
  onClose: () => void;
}

export function LongTextModal({ open, value, mode, onChange, onClose }: LongTextModalProps) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [copied, setCopied] = useState(false);
  const stats = longTextStats(value);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusFrame = window.requestAnimationFrame(() => {
      if (mode === "edit") editorRef.current?.focus();
      else closeRef.current?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [mode, open]);

  useEffect(() => {
    if (!open) setCopied(false);
  }, [open]);

  const copy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="long-text-modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 300,
            display: "grid",
            placeItems: "center",
            padding: 16,
            background: "rgba(12, 12, 14, 0.38)",
            backdropFilter: "blur(5px)",
          }}
        >
          <motion.div
            className="long-text-modal-panel"
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={t(mode === "edit" ? "longText.editTitle" : "longText.viewTitle")}
            initial={{ opacity: 0, y: 8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.99 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "min(920px, calc(100vw - 32px))",
              height: "min(760px, calc(100vh - 32px))",
              minHeight: 300,
              display: "grid",
              gridTemplateRows: "auto minmax(0, 1fr) auto",
              overflow: "hidden",
              border: "1px solid var(--separator)",
              borderRadius: 18,
              background: "var(--bg-elevated)",
              boxShadow: "0 24px 80px rgba(0, 0, 0, 0.28)",
            }}
          >
            <header
              style={{
                minHeight: 58,
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "0 14px 0 18px",
                borderBottom: "1px solid var(--separator)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 30,
                  height: 30,
                  flex: "0 0 auto",
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 9,
                  background: "var(--accent-muted)",
                  color: "var(--accent)",
                }}
              >
                <FileText size={15} />
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ color: "var(--text-primary)", fontSize: 13.5, fontWeight: 600 }}>
                  {t(mode === "edit" ? "longText.editTitle" : "longText.viewTitle")}
                </div>
                <div
                  style={{
                    marginTop: 2,
                    color: "var(--text-tertiary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                  }}
                >
                  {t("longText.stats", {
                    characters: String(stats.characters),
                    lines: String(stats.lines),
                  })}
                </div>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label={t("common.close")}
                title={t("common.close")}
                style={{
                  width: 32,
                  height: 32,
                  display: "grid",
                  placeItems: "center",
                  border: "none",
                  borderRadius: 8,
                  background: "transparent",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                <X size={16} />
              </button>
            </header>

            {mode === "edit" ? (
              <textarea
                ref={editorRef}
                value={value}
                onChange={(event) => onChange?.(event.target.value)}
                aria-label={t("longText.editorLabel")}
                spellCheck={false}
                style={{
                  width: "100%",
                  height: "100%",
                  minHeight: 0,
                  boxSizing: "border-box",
                  resize: "none",
                  overflow: "auto",
                  border: "none",
                  outline: "none",
                  padding: "24px clamp(20px, 4vw, 42px)",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  caretColor: "var(--accent)",
                  fontFamily: "var(--font-ui)",
                  fontSize: 14,
                  lineHeight: 1.7,
                  tabSize: 2,
                }}
              />
            ) : (
              <div
                tabIndex={0}
                style={{
                  minHeight: 0,
                  overflow: "auto",
                  padding: "24px clamp(20px, 4vw, 42px)",
                  background: "var(--bg-base)",
                  color: "var(--text-primary)",
                  fontFamily: "var(--font-ui)",
                  fontSize: 14,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  userSelect: "text",
                }}
              >
                {value}
              </div>
            )}

            <footer
              style={{
                minHeight: 58,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "10px 14px 10px 18px",
                borderTop: "1px solid var(--separator)",
              }}
            >
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  overflow: "hidden",
                  color: "var(--text-tertiary)",
                  fontSize: 11.5,
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t(mode === "edit" ? "longText.editHint" : "longText.viewHint")}
              </span>
              <div style={{ display: "flex", flex: "0 0 auto", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  onClick={copy}
                  style={{
                    height: 34,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "0 12px",
                    border: "1px solid var(--separator)",
                    borderRadius: 9,
                    background: "var(--bg-elevated)",
                    color: "var(--text-secondary)",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {t(copied ? "longText.copied" : "longText.copy")}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    height: 34,
                    padding: "0 15px",
                    border: "none",
                    borderRadius: 9,
                    background: "var(--accent)",
                    color: "var(--text-on-accent)",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {t(mode === "edit" ? "common.done" : "common.close")}
                </button>
              </div>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
