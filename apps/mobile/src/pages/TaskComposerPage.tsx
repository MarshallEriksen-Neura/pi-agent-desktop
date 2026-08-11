import { memo, useState, useCallback, useMemo } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { Send, FileText, AlertCircle, ArrowLeft } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import {
  Card,
  Row,
  PrimaryButton,
  StateView,
} from "@/components/primitives";
import { NetError } from "@/net/errors";
import type { RemoteTaskExecutionProfile } from "@pi/remote-control-contracts";

const MAX_PROMPT_BYTES = 16 * 1024; // 16 KiB (server limit)

interface ComposerState {
  contextFiles: string[];
}

/**
 * TaskComposerPage — composes a task submission. Receives selected context
 * files from the ProjectTreePage via router state.
 *
 * Safety (design §5):
 *  - `requestId` is generated once via UUID v4 and held in state — it makes the
 *    submission idempotent: a retry after a network blip returns the original
 *    task instead of creating a duplicate.
 *  - Anti-double-submit: the submit button is disabled while in-flight.
 *  - Prompt is validated against the 16 KiB server limit before sending.
 *  - Queue full (429) is surfaced distinctly.
 */
export const TaskComposerPage = memo(function TaskComposerPage() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { isOnline } = useConnection();
  const client = useConnectionStore((s) => s.client);

  const routerState = (location.state ?? {}) as ComposerState;
  const contextFiles = useMemo(
    () => routerState.contextFiles ?? [],
    [routerState.contextFiles],
  );

  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => generateRequestId());

  const promptBytes = useMemo(() => new Blob([prompt]).size, [prompt]);
  const overLimit = promptBytes > MAX_PROMPT_BYTES;
  const trimmedPrompt = prompt.trim();
  const canSubmit = isOnline && client !== null && !submitting && !overLimit && trimmedPrompt.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!client || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const snap = await client.createTask({
        requestId,
        projectId,
        prompt: trimmedPrompt,
        contextFiles: contextFiles.map((relativePath) => ({ relativePath })),
        executionProfile: "default" as RemoteTaskExecutionProfile,
      });
      // Success — navigate to the task detail.
      navigate(`/tasks/${encodeURIComponent(snap.taskId)}`, { replace: true });
    } catch (e) {
      if (e instanceof NetError) {
        if (e.kind === "queue_full") {
          setError("queue_full");
        } else if (e.kind === "project_revoked" || e.kind === "project_unavailable") {
          setError("project_revoked");
        } else if (e.kind === "invalid_context") {
          setError("invalid_context");
        } else {
          setError(e.message);
        }
      } else {
        setError("submit_failed");
      }
    } finally {
      setSubmitting(false);
    }
  }, [client, canSubmit, requestId, projectId, trimmedPrompt, contextFiles, navigate]);

  if (!isOnline) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.offline")}
        detail={t("error.offlineDetail")}
      />
    );
  }

  return (
    <div style={{ padding: "16px", overflowY: "auto", height: "100%", paddingBottom: 100 }}>
      {/* Header with back */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <motion.button
          whileTap={{ scale: 0.92 }}
          onClick={() => navigate(-1)}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--color-accent)",
            display: "grid",
            placeItems: "center",
            padding: 4,
          }}
        >
          <ArrowLeft size={22} />
        </motion.button>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", margin: 0 }}>
          {t("compose.title")}
        </h1>
      </div>

      {/* Context files summary */}
      {contextFiles.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-tertiary)", padding: "0 4px 8px" }}>
            {t("compose.contextFiles", { count: contextFiles.length })}
          </div>
          <Card>
            {contextFiles.slice(0, 5).map((f) => (
              <Row key={f} icon={<FileText size={16} />} title={f.split("/").pop() ?? f} detail={f} />
            ))}
            {contextFiles.length > 5 && (
              <div style={{ padding: "8px 16px", fontSize: 13, color: "var(--color-text-tertiary)" }}>
                {t("compose.moreFiles", { count: contextFiles.length - 5 })}
              </div>
            )}
          </Card>
        </div>
      )}

      {/* Prompt input */}
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-tertiary)", padding: "0 4px 8px" }}>
        {t("compose.prompt")}
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={6}
        placeholder={t("compose.promptPlaceholder")}
        style={{
          width: "100%",
          minHeight: 140,
          padding: 14,
          border: `1px solid ${overLimit ? "var(--color-danger)" : "var(--color-separator)"}`,
          borderRadius: "var(--radius-lg)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-text-primary)",
          fontSize: 16,
          fontFamily: "var(--font-ui)",
          resize: "none",
          outline: "none",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          color: overLimit ? "var(--color-danger)" : "var(--color-text-tertiary)",
          padding: "4px 4px 0",
        }}
      >
        <span>{overLimit ? t("compose.tooLong") : ""}</span>
        <span>
          {promptBytes} / {MAX_PROMPT_BYTES} B
        </span>
      </div>

      {/* Error */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            marginTop: 16,
            padding: "12px 14px",
            borderRadius: "var(--radius-md)",
            background: "var(--color-danger)",
            color: "#fff",
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {error === "queue_full"
            ? t("compose.queueFull")
            : error === "project_revoked"
              ? t("compose.projectRevoked")
              : error === "invalid_context"
                ? t("compose.invalidContext")
                : t("compose.submitFailed")}
        </motion.div>
      )}

      {/* Submit bar */}
      <div
        style={{
          position: "fixed",
          bottom: "calc(var(--safe-bottom) + 16px)",
          left: 16,
          right: 16,
          zIndex: 50,
        }}
      >
        <PrimaryButton onClick={handleSubmit} disabled={!canSubmit}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {submitting ? t("common.loading") : t("compose.submit")}
            <Send size={16} />
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
});

/**
 * Generate a stable, idempotent requestId for this composer session. UUID v4
 * via crypto when available, manual fallback otherwise. The id is held in state
 * for the lifetime of the page — a retry reuses it so the server deduplicates.
 */
function generateRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
