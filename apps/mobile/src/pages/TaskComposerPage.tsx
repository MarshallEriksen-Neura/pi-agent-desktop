import { memo, useState, useCallback, useMemo, useEffect } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { Send, FileText, AlertCircle, X } from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { useConversationStore } from "@/stores/conversation-store";
import { StateView } from "@/components/primitives";
import {
  SectionLabel,
  MobileCard,
  MobileRow,
  BlockButton,
  DetailHeader,
} from "@/components/visual";
import { SegmentedControl } from "@/components/segmented";
import { NetError } from "@/net/errors";
import { useModelCatalog, selectableModels } from "@/stores/models-store";
import type { RemoteTaskExecutionProfile } from "@pi/remote-control-contracts";

const MAX_PROMPT_BYTES = 16 * 1024; // 16 KiB (server limit)

interface ComposerState {
  contextFiles: string[];
}

/**
 * 快捷模板 —— 点击把句式插入输入框,不替换已有内容。
 *
 * 设计稿的 chip 高 24px,远低于可点最小值;这里用 .chip-tap 锁到 44px。
 * 模板文案是「动词 + 待填」的开头,不是完整句子:直接给完整 prompt 会让用户
 * 懒得改,提交一堆同质任务。
 */
const QUICK_TEMPLATES = [
  { labelKey: "compose.quickAnalyze", text: "分析这些日志，找出根因：" },
  { labelKey: "compose.quickFix", text: "修复这个报错：" },
  { labelKey: "compose.quickRefactor", text: "重构这部分代码，目标是：" },
  { labelKey: "compose.quickTest", text: "为这些文件补测试，覆盖：" },
  { labelKey: "compose.quickExplain", text: "解释这段代码的作用和调用关系" },
] as const;

/**
 * 思考强度。
 *
 * 设计稿画了三档(快速 / 标准 / 深度),但协议里 RemoteTaskExecutionProfile 只有
 * `default | extended` 两个值。做成三档就得让两档映射到同一个值 —— 那是给用户
 * 一个动了也没用的旋钮。所以这里只出两档,和线上协议一一对应。
 *
 * 要三档的话得先在 remote-control-contracts 里扩 profile 并在桌面端实现。
 */
type Thinking = RemoteTaskExecutionProfile;

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
  const v2Available = useConversationStore((s) => s.v2Available);
  const v2ProbeError = useConversationStore((s) => s.v2ProbeError);
  const probeCapabilities = useConversationStore((s) => s.probeCapabilities);
  const createConversation = useConversationStore((s) => s.createConversation);

  const routerState = (location.state ?? {}) as ComposerState;
  const selectedFiles = useMemo(
    () => routerState.contextFiles ?? [],
    [routerState.contextFiles],
  );

  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => generateRequestId());
  const [thinking, setThinking] = useState<Thinking>("default");
  const [modelRef, setModelRef] = useState<string | null>(null);
  // 用户从树里选完文件后可能改主意 —— 这一屏得能删,不用退回去重选。
  const [dropped, setDropped] = useState<ReadonlySet<string>>(() => new Set());

  const catalogModels = useModelCatalog((s) => s.models);
  const catalogAvailable = useModelCatalog((s) => s.available);
  const catalogError = useModelCatalog((s) => s.error);
  const catalogRefresh = useModelCatalog((s) => s.refresh);
  const selectable = useMemo(() => selectableModels(catalogModels), [catalogModels]);

  useEffect(() => {
    void probeCapabilities();
  }, [probeCapabilities]);

  useEffect(() => {
    if (v2Available === true && catalogAvailable === null) {
      void catalogRefresh();
    }
  }, [v2Available, catalogAvailable, catalogRefresh]);

  const contextFiles = useMemo(
    () => selectedFiles.filter((f) => !dropped.has(f)),
    [selectedFiles, dropped],
  );

  const promptBytes = useMemo(() => new Blob([prompt]).size, [prompt]);
  const overLimit = promptBytes > MAX_PROMPT_BYTES;
  const trimmedPrompt = prompt.trim();
  const canSubmit =
    isOnline &&
    client !== null &&
    v2Available === true &&
    !submitting &&
    !overLimit &&
    trimmedPrompt.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const conversationId = await createConversation({
        requestId,
        projectId,
        prompt: trimmedPrompt,
        contextFiles: contextFiles.map((relativePath) => ({ relativePath })),
        modelRef: modelRef ?? undefined,
      });
      if (conversationId) {
        navigate(`/tasks/${encodeURIComponent(conversationId)}`, {
          replace: true,
          state: { resourceKind: "conversation" },
        });
      } else {
        setError("submit_failed");
      }
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
    v2Available,
    createConversation,
    canSubmit,
    requestId,
    projectId,
    trimmedPrompt,
    contextFiles,
    navigate,
    modelRef,
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

      {/* Prompt input —— 任务目标是这一屏的主体,放在最前面。
          原版把上下文文件放在前面,但用户来这一屏时脑子里装的是「我要它干什么」,
          不是「我选了哪些文件」。 */}
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

      {/* 快捷模板 —— 插入句式开头,不替换已有内容 */}
      <div className="chips">
        {QUICK_TEMPLATES.map((tpl) => (
          <button
            key={tpl.labelKey}
            className="chip-tap"
            onClick={() =>
              setPrompt((prev) => (prev ? `${prev.replace(/\s*$/, "")}\n${tpl.text}` : tpl.text))
            }
          >
            + {t(tpl.labelKey)}
          </button>
        ))}
      </div>

      {/* Context files —— 每行可移除,空态说明 Pi 会自行检索 */}
      <SectionLabel>
        {t("compose.contextFiles", { count: contextFiles.length })}
      </SectionLabel>
      {contextFiles.length === 0 ? (
        <p
          style={{
            fontSize: 13,
            color: "var(--color-text-tertiary)",
            margin: "0 0 16px",
            lineHeight: 1.5,
          }}
        >
          {t("projects.contextEmpty")}
        </p>
      ) : (
        <MobileCard style={{ marginBottom: 16 }}>
          {contextFiles.map((f) => (
            <MobileRow
              key={f}
              icon={<FileText size={16} />}
              title={f.split("/").pop() ?? f}
              detail={f}
              trailing={
                <button
                  onClick={() => setDropped((prev) => new Set(prev).add(f))}
                  aria-label={`${t("compose.removeFile")} ${f}`}
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: "var(--tap-min)",
                    height: "var(--tap-min)",
                    flexShrink: 0,
                    border: "none",
                    background: "transparent",
                    color: "var(--color-text-tertiary)",
                    cursor: "pointer",
                  }}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              }
            />
          ))}
        </MobileCard>
      )}

      {/* 高级选项 —— 默认折叠。多数任务用默认档就够,不该占首屏空间。 */}
      <details className="adv">
        <summary>{t("compose.advanced")}</summary>
        <div style={{ paddingTop: 12 }}>
          <SectionLabel>{t("compose.thinkingLevel")}</SectionLabel>
          <SegmentedControl
            segments={[
              { key: "default", label: t("compose.thinkingStandard") },
              { key: "extended", label: t("compose.thinkingDeep") },
            ]}
            value={thinking}
            onChange={setThinking}
            label={t("compose.thinkingLevel")}
          />

          <SectionLabel>{t("compose.model")}</SectionLabel>
          {catalogAvailable === false ? (
            <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", margin: "0 0 16px" }}>
              {t("compose.modelUnavailable")}
            </p>
          ) : (
            <MobileCard style={{ marginBottom: 16 }}>
              <MobileRow
                icon={null}
                title={t("compose.modelDefault")}
                detail={t("compose.modelRefHint")}
                trailing={
                  <button
                    type="button"
                    className="chip-tap"
                    aria-pressed={modelRef === null}
                    onClick={() => setModelRef(null)}
                  >
                    {modelRef === null ? "✓" : ""}
                  </button>
                }
                onClick={() => setModelRef(null)}
              />
              {selectable.map((model) => (
                <MobileRow
                  key={model.ref}
                  icon={null}
                  title={model.displayName ?? model.modelId}
                  detail={model.ref}
                  trailing={
                    <button
                      type="button"
                      className="chip-tap"
                      aria-pressed={modelRef === model.ref}
                      onClick={() => setModelRef(model.ref)}
                    >
                      {modelRef === model.ref ? "✓" : ""}
                    </button>
                  }
                  onClick={() => setModelRef(model.ref)}
                />
              ))}
              {selectable.length === 0 && catalogAvailable === true && (
                <p
                  style={{
                    fontSize: 13,
                    color: "var(--color-text-tertiary)",
                    margin: 0,
                    padding: 12,
                  }}
                >
                  {catalogError || t("compose.modelUnavailable")}
                </p>
              )}            </MobileCard>
          )}
        </div>
      </details>

      {/* Error */}
      {v2Available !== true && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="error-banner"
          style={{ marginTop: 12 }}
        >
          <AlertCircle size={16} />
          <span>
            {v2Available === false
              ? t("compose.conversationUnavailable")
              : v2ProbeError || t("compose.checkingConversation")}
          </span>
          <button type="button" onClick={() => void probeCapabilities()}>
            {t("common.retry")}
          </button>
        </motion.div>
      )}

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
        {/* 按钮置灰时说明为什么 —— 一个灰按钮不给理由,用户只会反复点它 */}
        {trimmedPrompt.length === 0 && (
          <p
            style={{
              fontSize: 12,
              color: "var(--color-text-tertiary)",
              textAlign: "center",
              margin: "0 0 8px",
            }}
          >
            {t("compose.needPrompt")}
          </p>
        )}
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
            <Send size={16} aria-hidden="true" />
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
