import { memo, useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle,
  MessageSquare,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  FileText,
  Send,
  Archive,
  MoreHorizontal,
  ChevronDown,
  X,
} from "lucide-react";
import { t } from "@/i18n";
import { useConnection } from "@/hooks/useConnection";
import { useConnectionStore } from "@/stores/connection.store";
import { useTaskStore } from "@/stores/task-store";
import { useInteractionStore } from "@/stores/interaction-store";
import { usePromptCache } from "@/stores/prompt-cache";
import { useConversationStore } from "@/stores/conversation-store";
import { useExpiryCountdown } from "@/hooks/useExpiryCountdown";
import { useModelCatalog, selectableModels } from "@/stores/models-store";
import { StateView } from "@/components/primitives";
import { BlockButton, DetailHeader, MobileCard, MobileRow } from "@/components/visual";
import { LongPressButton } from "@/components/confirm";
import { Timeline, TimelineNode, OptionRow, PromptBox } from "@/components/task-visual";
import { DetailSkeleton, ListSkeleton } from "@/components/skeleton";
import {
  MessageBubble,
  ThinkingDots,
  ToolCard,
  WarningBlock,
  SystemNote,
  InlineInteraction,
  ResolvedInteraction,
} from "@/components/chat";
import { buildTranscript } from "@/lib/transcript";
import { NetError } from "@/net/errors";
import type {
  RemoteTaskSnapshot,
  RemoteTaskState,
  RemoteInteractionSnapshot,
} from "@pi/remote-control-contracts";
import { REMOTE_TASK_TERMINAL_STATES } from "@pi/remote-control-contracts";

/**
 * TaskDetailPage — the task rendered as a readable conversation.
 *
 * Layout follows iOS "content first": a glass header, the status as a hero
 * (large glyph + label, no card chrome), the lifecycle timeline sitting directly
 * on the background, then the transcript. Only a divider separates regions —
 * nesting cards inside cards (the previous design) buried the content.
 *
 * The transcript is built by {@link buildTranscript}, which merges consecutive
 * stdout deltas into single assistant messages. Pending interactions render
 * inline so the user answers with the surrounding context visible instead of
 * being sent to a separate page.
 *
 * There is deliberately no message input: the gateway accepts exactly one prompt
 * per task (`run_worker` sends it once), so a text field here would be a control
 * that does nothing. Follow-up input happens through interactions.
 */
export const TaskDetailPage = memo(function TaskDetailPage() {
  const { taskId = "" } = useParams();
  const probeCapabilities = useConversationStore((s) => s.probeCapabilities);

  useEffect(() => {
    void probeCapabilities();
  }, [probeCapabilities]);

  // Resource identity is durable; a transient capability probe must never
  // reinterpret an existing conversation as a legacy one-shot task (or vice
  // versa). Gateway-generated v2 IDs use the stable `conv-` prefix.
  if (taskId.startsWith("conv-")) {
    return <ConversationDetail conversationId={taskId} />;
  }

  return <LegacyTaskDetail taskId={taskId} />;
});

const LegacyTaskDetail = memo(function LegacyTaskDetail({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const { isOnline } = useConnection();
  const client = useConnectionStore((s) => s.client);

  const tasks = useTaskStore((s) => s.tasks);
  const output = useTaskStore((s) => s.output);
  const fetchTask = useTaskStore((s) => s.fetchTask);
  const clearOutput = useTaskStore((s) => s.clearOutput);
  const interactions = useInteractionStore((s) => s.interactions);
  const cachedPrompt = usePromptCache((s) => s.prompts[taskId] ?? null);

  const [localSnapshot, setLocalSnapshot] = useState<RemoteTaskSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Prefer the store's task (live); fall back to a local fetch result.
  const storeTask = tasks.find((task) => task.taskId === taskId);
  const task = storeTask ?? localSnapshot;

  const taskInteractions = useMemo(
    () => Object.values(interactions).filter((ix) => ix.taskId === taskId),
    [interactions, taskId],
  );
  const fragments = output[taskId] ?? [];

  const transcript = useMemo(
    () => buildTranscript(cachedPrompt, fragments, taskInteractions),
    [cachedPrompt, fragments, taskInteractions],
  );

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const snap = await client.getTask(taskId);
      if (snap) setLocalSnapshot(snap);
    } catch (e) {
      setError(e instanceof NetError ? e.message : "fetch_failed");
    } finally {
      setLoading(false);
    }
  }, [client, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Also push into the store so the event stream can update it.
  useEffect(() => {
    void fetchTask(taskId);
  }, [fetchTask, taskId]);

  const handleCancel = useCallback(async () => {
    if (!client || !task) return;
    setCancelling(true);
    try {
      await client.cancelTask(taskId);
      void fetchTask(taskId);
    } catch {
      // The event stream will reconcile.
    } finally {
      setCancelling(false);
    }
  }, [client, task, taskId, fetchTask]);

  // Cleanup output when leaving the page.
  useEffect(() => {
    return () => clearOutput(taskId);
  }, [clearOutput, taskId]);

  if (!isOnline && !task) {
    return (
      <StateView
        icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
        title={t("error.offline")}
        detail={t("error.offlineDetail")}
      />
    );
  }

  // 骨架而非转圈:标题块 + 段落 + 代码块的形状预告了落地后的内容,不跳版。
  if (loading && !task) {
    return (
      <div className="page-scroll">
        <DetailHeader title={t("detail.pageTitle")} onBack={() => navigate(-1)} />
        <DetailSkeleton />
      </div>
    );
  }

  if (error && !task) {
    return (
      <div className="page-scroll">
        <DetailHeader title={t("detail.pageTitle")} onBack={() => navigate(-1)} />
        <StateView
          icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />}
          title={t("error.unknown")}
          detail={error}
          action={
            <BlockButton variant="primary" onClick={load}>
              {t("common.retry")}
            </BlockButton>
          }
        />
      </div>
    );
  }

  if (!task) return null;

  const isTerminal = REMOTE_TASK_TERMINAL_STATES.includes(task.state);
  const isAwaitingInput = task.state === "awaiting_input";
  const visual = STATE_VISUAL[task.state];
  // Thinking dots only while the task is genuinely working with nothing to show.
  const showThinking = !isTerminal && !isAwaitingInput && transcript.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Glass header floats over the transcript */}
      <div className="detail-head-glass">
        <button
          className="back"
          onClick={() => navigate(-1)}
          aria-label={t("common.back")}
        >
          ‹
        </button>
        <span className="dh">{cachedPrompt ?? t("detail.pageTitle")}</span>
      </div>

      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 24 }}>
        {/* Status as hero — no card chrome */}
        <div className="status-hero">
          <div
            className="sicon"
            style={{
              background: `color-mix(in srgb, ${visual.color} 16%, transparent)`,
              color: visual.color,
            }}
          >
            {visual.icon}
          </div>
          <div className="stitle" style={{ color: visual.color }}>
            {t(`tasks.state.${task.state}`)}
          </div>
          <div className="ssub">{describeTask(task)}</div>
        </div>

        {/* Legacy one-shot task: readable but never appendable. The badge
            makes the missing composer intentional, not a bug. */}
        <div className="legacy-badge">
          {t("detail.legacyReadOnly")}
        </div>

        {/* Lifecycle timeline, directly on the background */}
        <Timeline>
          <TimelineNode
            label={t("detail.stateCreated")}
            time={formatTime(task.createdAt)}
            dot="done"
          />
          {task.startedAt && (
            <TimelineNode
              label={t("detail.stateStarted")}
              time={formatTime(task.startedAt)}
              dot="done"
            />
          )}
          <TimelineNode
            label={
              isTerminal ? t(`tasks.state.${task.state}`) : t("detail.stateRunning")
            }
            time={task.finishedAt ? formatTime(task.finishedAt) : undefined}
            dot={isTerminal ? "done" : isAwaitingInput ? "await" : "live"}
          />
        </Timeline>

        {/* Error detail, when the gateway reported one */}
        {task.error && (
          <div style={{ padding: "4px 16px 8px" }}>
            <MobileCard style={{ borderColor: "var(--color-danger)", padding: 12 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--color-danger)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {task.error.code}
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: "var(--color-text-secondary)",
                  lineHeight: 1.45,
                  marginTop: 4,
                }}
              >
                {task.error.message}
              </div>
              {task.error.retryable && (
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--color-text-tertiary)",
                    marginTop: 6,
                  }}
                >
                  {t("detail.retryable")}
                </div>
              )}
            </MobileCard>
          </div>
        )}

        <div className="divider-label">{t("detail.output")}</div>

        {/* The conversation */}
        <TranscriptView
          entries={transcript}
          showThinking={showThinking}
          hasPrompt={cachedPrompt !== null}
          contextCount={task.contextFiles.length}
        />

        {/* Context files — collapsed by default; large but rarely needed */}
        {task.contextFiles.length > 0 && (
          <details style={{ padding: "8px 16px 0" }}>
            <summary
              style={{
                fontSize: 12.5,
                color: "var(--color-text-tertiary)",
                cursor: "pointer",
                listStyle: "none",
                padding: "6px 0",
              }}
            >
              {t("detail.contextFiles")} · {task.contextFiles.length}
            </summary>
            <MobileCard style={{ marginTop: 6 }}>
              {task.contextFiles.map((file) => (
                <div key={file.relativePath} className="mrow" style={{ cursor: "default" }}>
                  <span className="mic" style={{ background: "var(--color-gray-1)" }}>
                    <FileText size={15} />
                  </span>
                  <div className="mb">
                    <div className="mt">
                      {file.relativePath.split("/").pop() ?? file.relativePath}
                    </div>
                    <div className="md">{file.relativePath}</div>
                  </div>
                </div>
              ))}
            </MobileCard>
          </details>
        )}

        {/* Cancel, with the consequence stated */}
        {!isTerminal && (
          <div className="cancel-zone">
            <BlockButton variant="outline" onClick={handleCancel} disabled={cancelling}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  justifyContent: "center",
                  color: "var(--color-danger)",
                }}
              >
                <Ban size={16} />
                {cancelling ? t("common.loading") : t("detail.cancel")}
              </span>
            </BlockButton>
            <div className="cancel-hint">{t("detail.cancelHint")}</div>
          </div>
        )}
      </div>
    </div>
  );
});

const ConversationDetail = memo(function ConversationDetail({ conversationId }: { conversationId: string }) {
  const navigate = useNavigate();
  const { isOnline } = useConnection();
  const open = useConversationStore((s) => s.open);
  const openConversation = useConversationStore((s) => s.openConversation);
  const appendTurn = useConversationStore((s) => s.appendTurn);
  const cancelTurn = useConversationStore((s) => s.cancelTurn);
  const archiveConversation = useConversationStore((s) => s.archiveConversation);
  const error = useConversationStore((s) => s.error);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [followUpModelRef, setFollowUpModelRef] = useState<string | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const catalogModels = useModelCatalog((s) => s.models);
  const catalogAvailable = useModelCatalog((s) => s.available);
  const catalogRefresh = useModelCatalog((s) => s.refresh);
  const selectable = useMemo(() => selectableModels(catalogModels), [catalogModels]);

  useEffect(() => {
    void openConversation(conversationId);
    return () => {
      useConversationStore.getState().closeConversation();
    };
  }, [conversationId, openConversation]);

  useEffect(() => {
    if (catalogAvailable === null) {
      void catalogRefresh();
    }
  }, [catalogAvailable, catalogRefresh]);

  const snapshot = open?.snapshot.conversationId === conversationId ? open.snapshot : null;
  const messages = open?.snapshot.conversationId === conversationId ? open.messages : [];
  const activeTurn = snapshot?.activeTurn;
  const currentModelRef =
    followUpModelRef ?? activeTurn?.modelRef ?? snapshot?.latestTurn?.modelRef ?? snapshot?.defaultModelRef;

  // Follow the stream: new messages (user submit or assistant delta/complete)
  // and turn transitions scroll the transcript to the latest line. Only while
  // the user is near the bottom — reading history is never interrupted.
  const lastMessageText = messages[messages.length - 1]?.text ?? "";
  useEffect(() => {
    const scroller = transcriptScrollRef.current;
    if (!scroller) return;
    const nearBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    if (!nearBottom) return;
    transcriptEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, lastMessageText, activeTurn?.turnId]);
  const submit = useCallback(async () => {
    const text = prompt.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const accepted = await appendTurn(conversationId, {
        requestId: generateRequestId(),
        prompt: text,
        modelRef: followUpModelRef ?? undefined,
      });
      if (accepted) {
        setPrompt("");
        setFollowUpModelRef(null);
      }
    } finally {
      setSubmitting(false);
    }
  }, [appendTurn, conversationId, prompt, submitting, followUpModelRef]);

  if (!isOnline && !snapshot) {
    return <StateView icon={<AlertCircle size={28} style={{ color: "var(--color-text-tertiary)" }} />} title={t("error.offline")} detail={t("error.offlineDetail")} />;
  }
  if (!snapshot) {
    return <div className="page-scroll"><DetailHeader title={t("detail.pageTitle")} onBack={() => navigate(-1)} /><FullScreenLoading error={error} /></div>;
  }

  // 连续同角色消息合并为一组:组内气泡贴紧、不重复时间戳,形成阅读节奏。
  const groupedRoles = messages.map((message) => (message.role === "user" ? "user" : "assistant"));
  const isGrouped = (index: number) =>
    index > 0 && groupedRoles[index] === groupedRoles[index - 1];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", position: "relative" }}>
      {/* 顶栏:返回 + 居中标题/副标题 + ⋯ 菜单(归档/取消收进去) */}
      <div className="detail-head-glass">
        <button className="back" onClick={() => navigate(-1)} aria-label={t("common.back")}>‹</button>
        <div className="dh-wrap">
          <span className="dh">{snapshot.title || t("detail.pageTitle")}</span>
          <span className="dh-sub">
            {t(`tasks.state.${snapshot.status}`)} · {t("detail.turnsCount", { count: snapshot.turnCount })} · {currentModelRef ?? t("detail.modelDefault")}
          </span>
        </div>
        <div className="head-actions">
          <button
            type="button"
            className="head-icon-btn"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={t("detail.moreActions")}
            aria-expanded={menuOpen}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
      </div>

      {/* ⋯ 下拉菜单:纸面卡片 + 发丝线,归档墨色 / 取消朱砂 */}
      {menuOpen && (
        <>
          <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
          <div className="head-menu">
            <button
              type="button"
              className="head-menu-row"
              onClick={() => {
                setMenuOpen(false);
                if (window.confirm(t("detail.archiveConfirm"))) {
                  void archiveConversation(conversationId, generateRequestId());
                }
              }}
            >
              <Archive size={16} />
              <span>{t("detail.archive")}</span>
            </button>
            {activeTurn && (
              <button
                type="button"
                className="head-menu-row danger"
                onClick={() => {
                  setMenuOpen(false);
                  void cancelTurn(activeTurn.turnId, generateRequestId());
                }}
              >
                <Ban size={16} />
                <span>{t("detail.cancelTurn")}</span>
              </button>
            )}
          </div>
        </>
      )}

      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 24 }} ref={transcriptScrollRef}>
        <div className="transcript">
          {messages.length === 0 && <div className="hint">{t("chat.noActivity")}</div>}
          {messages.map((message, index) => (
            <MessageBubble
              key={message.messageId}
              role={message.role === "user" ? "user" : "assistant"}
              text={message.text}
              time={formatClock(message.createdAt)}
              grouped={isGrouped(index)}
            />
          ))}
          {snapshot.pendingInteraction && <SystemNote text={snapshot.pendingInteraction.prompt} />}
          {activeTurn && <ThinkingDots />}
          <div ref={transcriptEndRef} />
        </div>
      </div>
      {snapshot.status !== "archived" && snapshot.status !== "unavailable" && (
        <div className="glass-composer">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={2}
            placeholder={t("chat.inputPlaceholder")}
            className="composer-input"
          />
          <div className="composer-foot">
            <button
              type="button"
              className="model-chip-sm"
              onClick={() => setModelPickerOpen((open) => !open)}
              aria-expanded={modelPickerOpen}
            >
              {currentModelRef ?? t("detail.modelDefault")}
              <ChevronDown size={12} />
            </button>
            <button
              type="button"
              className="composer-send"
              onClick={() => void submit()}
              disabled={submitting || prompt.trim().length === 0}
              aria-label={t("chat.send")}
            >
              <Send size={17} />
            </button>
          </div>
        </div>
      )}
      {/* 模型选择浮层:贴在 composer 上方,不再霸占正文首屏;选中即收起 */}
      {modelPickerOpen && (
        <>
          <div className="menu-scrim" onClick={() => setModelPickerOpen(false)} />
          <div className="model-sheet">
            <div className="model-sheet-head">
              <span>{t("detail.model")}</span>
              <button
                type="button"
                className="head-icon-btn"
                onClick={() => setModelPickerOpen(false)}
                aria-label={t("common.back")}
              >
                <X size={16} />
              </button>
            </div>
            <div className="model-sheet-body">
              <MobileRow
                icon={null}
                title={t("detail.modelDefault")}
                detail={t("detail.modelFollowUpHint")}
                onClick={() => {
                  setFollowUpModelRef(null);
                  setModelPickerOpen(false);
                }}
                trailing={<span>{followUpModelRef === null ? "✓" : ""}</span>}
              />
              {selectable.map((model) => (
                <MobileRow
                  key={model.ref}
                  icon={null}
                  title={model.displayName ?? model.modelId}
                  detail={model.ref}
                  onClick={() => {
                    setFollowUpModelRef(model.ref);
                    setModelPickerOpen(false);
                  }}
                  trailing={<span>{followUpModelRef === model.ref ? "✓" : ""}</span>}
                />
              ))}
              {selectable.length === 0 && (
                <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", margin: 0, padding: 12 }}>
                  {t("compose.modelUnavailable")}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
});

function FullScreenLoading({ error }: { error: string | null }) {
  // ConversationDetail 专属加载态:不是整个详情页的初始骨架(前面已有),是会话
  // 特定场景——用户展开了 chat 区但流还没准备好。error 态无法预测形状,StateView 合理。
  if (error) {
    return <StateView icon={<AlertCircle size={24} />} title={t("error.unknown")} detail={error} />;
  }
  // 正常加载用紧凑骨架,不霸占全屏——这时顶部 task 主信息已渲染,只是聊天区还空着。
  return <ListSkeleton count={2} />;
}

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

// ----------------------------------------------------------------
// Transcript rendering
// ----------------------------------------------------------------

const TranscriptView = memo(function TranscriptView({
  entries,
  showThinking,
  hasPrompt,
  contextCount,
}: {
  entries: ReturnType<typeof buildTranscript>;
  showThinking: boolean;
  hasPrompt: boolean;
  contextCount: number;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the stream as new entries arrive.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [entries.length]);

  if (entries.length === 0 && !showThinking) {
    return <div className="hint">{t("chat.noActivity")}</div>;
  }

  return (
    <div className="transcript">
      {/* The prompt is cached locally, not returned by the gateway — say so
          rather than fabricating a user bubble. */}
      {!hasPrompt && contextCount > 0 && (
        <SystemNote text={t("chat.contextOnly")} />
      )}

      {entries.map((entry) => {
        switch (entry.kind) {
          case "user":
            return <MessageBubble key={entry.id} role="user" text={entry.text} />;
          case "assistant":
            return (
              <MessageBubble
                key={entry.id}
                role="assistant"
                text={entry.text}
                time={formatClock(entry.at)}
              />
            );
          case "tool":
            return <ToolCard key={entry.id} tool={entry.tool} />;
          case "warning":
            return <WarningBlock key={entry.id} text={entry.text} />;
          case "system":
            return <SystemNote key={entry.id} text={entry.text} />;
          case "interaction":
            return (
              <InteractionEntry key={entry.id} interaction={entry.interaction} />
            );
        }
      })}

      {showThinking && <ThinkingDots />}
      <div ref={endRef} />
    </div>
  );
});

/**
 * One interaction inside the transcript. Pending renders an answerable card;
 * resolved/expired collapses to a one-line summary so history stays traceable
 * without eating space.
 */
const InteractionEntry = memo(function InteractionEntry({
  interaction,
}: {
  interaction: RemoteInteractionSnapshot;
}) {
  const respond = useInteractionStore((s) => s.respond);
  const isResponding = useInteractionStore((s) =>
    s.responding.has(interaction.interactionId),
  );
  const remaining = useExpiryCountdown(interaction.expiresAt);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (interaction.status !== "pending") {
    return (
      <ResolvedInteraction
        prompt={interaction.prompt}
        answer={
          interaction.status === "expired"
            ? t("chat.expiredAnswer")
            : formatAnswer(interaction)
        }
        expired={interaction.status === "expired"}
      />
    );
  }

  const expired = remaining === 0;
  const locked = isResponding || expired;

  return (
    <InlineInteraction countdown={remaining !== null ? formatRemaining(remaining) : undefined}>
      <PromptBox>{interaction.prompt}</PromptBox>

      {/* confirm 的两个分支不对称:「拒绝」是安全默认,「批准」可能不可逆
          (合并、推送、删除都走这条路)。所以不做成并列双按钮 —— 拒绝单击可达,
          批准要长按。旧版把 Yes 放在左边且单击生效,在手机上远程误触代价太高。 */}
      {interaction.kind === "confirm" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <BlockButton
            variant="outline"
            disabled={locked}
            onClick={() => void respond(interaction.interactionId, "confirm", false)}
          >
            {t("interaction.reject")}
          </BlockButton>
          <LongPressButton
            disabled={locked}
            onConfirm={() => void respond(interaction.interactionId, "confirm", true)}
          >
            {t("confirm.longPress")}
          </LongPressButton>
        </div>
      )}

      {interaction.kind === "select" && (
        <>
          {(interaction.options ?? []).map((opt) => (
            <OptionRow
              key={opt.value}
              label={opt.label}
              selected={selected === opt.value}
              onClick={() => setSelected(opt.value)}
              disabled={locked}
            />
          ))}
          <BlockButton
            variant="success"
            disabled={locked || selected === null}
            onClick={() => {
              if (selected !== null) {
                void respond(interaction.interactionId, "select", selected);
              }
            }}
          >
            {t("interaction.submit")}
          </BlockButton>
        </>
      )}

      {interaction.kind === "input" && (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={locked}
            rows={3}
            placeholder={t("interaction.inputPlaceholder")}
            className="prompt-input"
            style={{ minHeight: 72, fontSize: 16 }}
          />
          <BlockButton
            variant="success"
            disabled={locked || draft.trim().length === 0}
            onClick={() =>
              void respond(interaction.interactionId, "input", draft.trim())
            }
          >
            {t("interaction.submit")}
          </BlockButton>
        </>
      )}
    </InlineInteraction>
  );
});

// ----------------------------------------------------------------
// Presentation helpers
// ----------------------------------------------------------------

const STATE_VISUAL: Record<
  RemoteTaskState,
  { icon: React.ReactNode; color: string }
> = {
  queued: { icon: <Clock size={24} />, color: "var(--color-text-secondary)" },
  starting: { icon: <Clock size={24} />, color: "var(--color-text-secondary)" },
  running: {
    icon: <Loader2 size={24} className="pi-spin" />,
    color: "var(--color-accent)",
  },
  awaiting_input: {
    icon: <MessageSquare size={24} />,
    color: "var(--color-status-awaiting)",
  },
  succeeded: { icon: <CheckCircle2 size={24} />, color: "var(--color-success)" },
  failed: { icon: <XCircle size={24} />, color: "var(--color-danger)" },
  cancelled: { icon: <XCircle size={24} />, color: "var(--color-text-tertiary)" },
};

/** "已运行 2 分 10 秒 · 3 个上下文文件" — duration plus context count. */
function describeTask(task: RemoteTaskSnapshot): string {
  const parts: string[] = [];
  const start = task.startedAt ?? task.createdAt;
  const end = task.finishedAt ?? new Date().toISOString();
  const seconds = Math.max(
    0,
    Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 1000),
  );
  if (Number.isFinite(seconds)) {
    parts.push(formatDuration(seconds));
  }
  if (task.contextFiles.length > 0) {
    parts.push(`${task.contextFiles.length} ${t("detail.contextFiles")}`);
  }
  return parts.join(" · ");
}

function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRemaining(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatAnswer(interaction: RemoteInteractionSnapshot): string {
  const value = interaction.response?.value;
  if (value === undefined) return t("chat.answered");
  if (typeof value === "boolean") {
    return value ? t("interaction.yes") : t("interaction.no");
  }
  return String(value);
}
