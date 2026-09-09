"use client";

import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { useSessions, type TrashedSessionMeta } from "@/lib/pi/sessions";
import { useT } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";

export function SessionTrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const {
    trashedSessions,
    trashLoaded,
    loadTrash,
    restoreTrashedSession,
    purgeTrashedSession,
    emptyTrash,
  } = useSessions();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashedSessionMeta | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    void loadTrash().catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, [open, loadTrash]);

  const sorted = useMemo(
    () => [...trashedSessions].sort((a, b) => b.deletedAt - a.deletedAt),
    [trashedSessions]
  );

  const restore = async (session: TrashedSessionMeta) => {
    setBusyId(session.tombstoneId);
    setError("");
    try {
      await restoreTrashedSession(session.tombstoneId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const purge = async () => {
    if (!purgeTarget) return;
    const id = purgeTarget.tombstoneId;
    setBusyId(id);
    setError("");
    try {
      await purgeTrashedSession(id);
      setPurgeTarget(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  const purgeAll = async () => {
    setError("");
    try {
      await emptyTrash();
      setConfirmEmpty(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={OVERLAY}
            role="dialog"
            aria-modal="true"
            aria-label={t("trash.title")}
          >
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.985 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              style={CARD}
            >
              <div style={HEADER}>
                <div>
                  <div style={TITLE}>{t("trash.title")}</div>
                  <div style={SUBTITLE}>{t("trash.subtitle")}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {sorted.length > 0 && (
                    <button
                      className="pi-row"
                      onClick={() => setConfirmEmpty(true)}
                      style={TEXT_BUTTON_DANGER}
                    >
                      <Trash2 size={13} />
                      {t("trash.empty")}
                    </button>
                  )}
                  <button
                    className="pi-row"
                    onClick={onClose}
                    aria-label={t("common.close")}
                    title={t("common.close")}
                    style={ICON_BUTTON}
                  >
                    <X size={15} />
                  </button>
                </div>
              </div>

              <div style={LIST}>
                {!trashLoaded ? (
                  <div style={EMPTY}>
                    <Loader2 size={16} className="pi-spin" />
                    {t("trash.loading")}
                  </div>
                ) : sorted.length === 0 ? (
                  <div style={EMPTY}>{t("trash.emptyState")}</div>
                ) : (
                  sorted.map((session) => {
                    const busy = busyId === session.tombstoneId;
                    const name = session.name || t("session.untitled");
                    return (
                      <div key={session.tombstoneId} style={ROW}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={ROW_TITLE} title={name}>{name}</div>
                          <div style={ROW_META}>
                            {new Date(session.deletedAt).toLocaleString()}
                          </div>
                          {session.preview && (
                            <div style={ROW_PREVIEW} title={session.preview}>
                              {session.preview}
                            </div>
                          )}
                        </div>
                        <div style={ROW_ACTIONS}>
                          <button
                            className="pi-row"
                            disabled={busy}
                            onClick={() => void restore(session)}
                            title={t("trash.restore")}
                            aria-label={t("trash.restore")}
                            style={ICON_BUTTON}
                          >
                            {busy ? <Loader2 size={14} className="pi-spin" /> : <RotateCcw size={14} />}
                          </button>
                          <button
                            className="pi-row"
                            disabled={busy}
                            onClick={() => setPurgeTarget(session)}
                            title={t("trash.deleteForever")}
                            aria-label={t("trash.deleteForever")}
                            style={{ ...ICON_BUTTON, color: "var(--danger)" }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {error && <div style={ERROR}>{error}</div>}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={purgeTarget !== null}
        title={t("trash.deleteForeverTitle")}
        message={t("trash.deleteForeverMessage")}
        detail={purgeTarget?.name || purgeTarget?.sessionPath || undefined}
        confirmLabel={t("trash.deleteForever")}
        onConfirm={purge}
        onCancel={() => setPurgeTarget(null)}
      />

      <ConfirmDialog
        open={confirmEmpty}
        title={t("trash.emptyTitle")}
        message={t("trash.emptyMessage", { count: sorted.length })}
        detail={t("trash.emptyDetail")}
        confirmLabel={t("trash.empty")}
        onConfirm={purgeAll}
        onCancel={() => setConfirmEmpty(false)}
      />
    </>
  );
}

const OVERLAY: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 900,
  display: "grid",
  placeItems: "center",
  background: "rgba(0,0,0,.36)",
  backdropFilter: "blur(2px)",
};

const CARD: React.CSSProperties = {
  width: 520,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "min(640px, calc(100vh - 48px))",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-base)",
  border: "1px solid var(--separator)",
  borderRadius: 14,
  boxShadow: "var(--shadow-lg)",
  overflow: "hidden",
};

const HEADER: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 16px 12px 18px",
  borderBottom: "1px solid var(--separator)",
};

const TITLE: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 650,
  color: "var(--text-primary)",
};

const SUBTITLE: React.CSSProperties = {
  marginTop: 3,
  fontSize: 12,
  color: "var(--text-tertiary)",
};

const LIST: React.CSSProperties = {
  minHeight: 160,
  overflowY: "auto",
  padding: "6px",
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 10px 10px 12px",
  borderRadius: 9,
};

const ROW_TITLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 560,
  color: "var(--text-primary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROW_META: React.CSSProperties = {
  marginTop: 2,
  fontSize: 11,
  color: "var(--text-tertiary)",
};

const ROW_PREVIEW: React.CSSProperties = {
  marginTop: 4,
  fontSize: 11.5,
  lineHeight: 1.35,
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROW_ACTIONS: React.CSSProperties = {
  display: "flex",
  gap: 4,
  flexShrink: 0,
};

const ICON_BUTTON: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "grid",
  placeItems: "center",
  border: "none",
  borderRadius: 7,
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const TEXT_BUTTON_DANGER: React.CSSProperties = {
  height: 28,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "0 8px",
  border: "none",
  borderRadius: 7,
  background: "transparent",
  color: "var(--danger)",
  fontSize: 12,
  cursor: "pointer",
};

const EMPTY: React.CSSProperties = {
  minHeight: 150,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "var(--text-tertiary)",
  fontSize: 12.5,
};

const ERROR: React.CSSProperties = {
  margin: "0 12px 12px",
  padding: "8px 10px",
  borderRadius: 8,
  background: "color-mix(in srgb, var(--danger) 10%, transparent)",
  color: "var(--danger)",
  fontSize: 12,
  wordBreak: "break-word",
};
