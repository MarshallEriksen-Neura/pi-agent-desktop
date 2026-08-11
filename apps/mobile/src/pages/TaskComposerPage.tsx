import { memo, useState, useCallback, useMemo } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { Send, FileText, AlertCircle } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { StateView } from "@/components/primitives";
import {
  SectionLabel,
  MobileCard,
  MobileRow,
  BlockButton,
  DetailHeader,
} from "@/components/visual";
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
  const canSubmit =
    isOnline &&
    client !== null &&
    !submitting &&
    !overLimit &&
    trimmedPrompt.length > 0;

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
        } else if (
          e.kind === "project_revoked" ||
          e.kind === "project_unavailable"
        ) {
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
  }, [
    client,
    canSubmit,
    requestId,
    projectId,
    trimmedPrompt,
    contextFiles,
    navigate,
  ]);

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
    <div className="page-scroll" style={{ paddingBottom: 100 }}>
      <DetailHeader title={t("compose.title")} onBack={() => navigate(-1)} />

      {/* Context files summary */}
      {contextFiles.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>
            {t("compose.contextFiles", { count: contextFiles.length })}
          </SectionLabel>
          <MobileCard>
            {contextFiles.slice(0, 5).map((f) => (
              <MobileRow
                key={f}
                icon={<FileText size={16} />}
                title={f.split("/").pop() ?? f}
                detail={f}
              />
            ))}
            {contextFiles.length > 5 && (
              <div className="more-hint">
                {t("compose.moreFiles", { count: contextFiles.length - 5 })}
              </div>
            )}
          </MobileCard>
        </div>
      )}

      {/* Prompt input */}
      <SectionLabel>{t("compose.prompt")}</SectionLabel>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={6}
        placeholder={t("compose.promptPlaceholder")}
        className={`prompt-input${overLimit ? " over" : ""}`}
      />
      <div className={`prompt-meter${overLimit ? " over" : ""}`}>
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
          className="error-banner"
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
      <div className="sticky-bar">
        <BlockButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              justifyContent: "center",
            }}
          >
            {submitting ? t("common.loading") : t("compose.submit")}
            <Send size={16} />
          </span>
        </BlockButton>
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
