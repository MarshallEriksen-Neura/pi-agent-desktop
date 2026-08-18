import { memo, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronLeft,
  Check,
  MessageSquare,
  X,
} from "lucide-react";
import { t } from "@/i18n";
import { useShallow } from "zustand/react/shallow";
import {
  selectSheetStack,
  useInteractionStore,
} from "@/stores/interaction-store";
import { useExpiryCountdown, formatCountdown } from "@/hooks/useExpiryCountdown";
import { LongPressButton } from "@/components/confirm";
import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

/**
 * InteractionSheet — 全局底部弹层,移动端唯一的回答面。
 *
 * 为什么是弹层而不是对话流里的表单:交互请求本质上是「Pi 在任务中间停下等你」,
 * 打断感应该来自一个明确的、可滑动关闭的临时层,而不是长在转录里的死板卡片。
 * 多题问卷(rpiv-ask-user-question 的 RPC 形态是逐题发送)在这里叠成一组,
 * 支持:
 *  - 左滑/右滑在题目间切换,direction-aware 的弹簧过渡
 *  - 回退到上一题,草稿(已选选项/已输入文本)原样保留
 *  - 答完最后一题后短暂停留,衔接 Pi 紧跟的下一问(问卷式连问)
 *
 * 手势分工:整张 sheet 下拉关闭;题目正文横滑换题;按钮/输入区不参与横滑。
 */

/** 答完最后一题后,等待 Pi 下一问的窗口(ms)。 */
const FOLLOWUP_GRACE_MS = 1100;

interface QuestionDraft {
  selected?: string;
  text?: string;
  customOpen?: boolean;
}

const slideVariants = {
  enter: (dir: number) => ({ x: dir * 64, opacity: 0, scale: 0.98 }),
  center: { x: 0, opacity: 1, scale: 1 },
  exit: (dir: number) => ({ x: dir * -64, opacity: 0, scale: 0.98 }),
};

export const InteractionSheet = memo(function InteractionSheet() {
  const stack = useInteractionStore(useShallow(selectSheetStack));
  const open = useInteractionStore((s) => s.sheetOpen);
  const focusId = useInteractionStore((s) => s.sheetFocusId);
  const closeSheet = useInteractionStore((s) => s.closeSheet);

  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [direction, setDirection] = useState(1);
  const [finishing, setFinishing] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const answeredRef = useRef<Set<string>>(new Set());

  // 本地 focus 跟随 store 的 sheetFocusId;打开时重置草稿与回退集。
  useEffect(() => {
    if (!open) return;
    setFocus(focusId);
  }, [open, focusId]);

  useEffect(() => {
    if (!open) return;
    answeredRef.current = new Set();
    setDrafts({});
    setFinishing(false);
  }, [open]);

  // 焦点协调:当前题被回答(从 pending 消失)后前移到下一未答题;全部答完
  // 进入 finishing,短暂停留等待 Pi 的下一问,窗口内无新题则收起。
  useEffect(() => {
    if (!open) return;
    if (stack.length === 0) {
      setFinishing(true);
      const timer = window.setTimeout(() => closeSheet(), FOLLOWUP_GRACE_MS);
      return () => window.clearTimeout(timer);
    }
    setFinishing(false);
    const at = stack.findIndex((ix) => ix.interactionId === focus);
    if (at === -1 || answeredRef.current.has(stack[at]?.interactionId ?? "")) {
      const next = stack.find((ix) => !answeredRef.current.has(ix.interactionId));
      if (next) {
        setDirection(1);
        setFocus(next.interactionId);
      }
    }
  }, [stack, focus, open, closeSheet]);

  const index = Math.max(
    0,
    stack.findIndex((ix) => ix.interactionId === focus),
  );
  const current = stack[index] ?? null;

  const setDraft = useCallback((interactionId: string, patch: Partial<QuestionDraft>) => {
    setDrafts((prev) => ({ ...prev, [interactionId]: { ...prev[interactionId], ...patch } }));
  }, []);

  const goTo = useCallback((nextIndex: number, dir: 1 | -1) => {
    const ix = stack[nextIndex];
    if (!ix) return;
    setDirection(dir);
    setFocus(ix.interactionId);
  }, [stack]);

  const prev = useCallback(() => {
    if (index > 0) goTo(index - 1, -1);
  }, [index, goTo]);

  const next = useCallback(() => {
    if (index < stack.length - 1) goTo(index + 1, 1);
  }, [index, stack.length, goTo]);

  const answer = useCallback(
    async (value: boolean | string) => {
      if (!current || answeredRef.current.has(current.interactionId)) return;
      const ok = await useInteractionStore
        .getState()
        .respond(current.interactionId, current.kind, value);
      if (!ok) return;
      answeredRef.current.add(current.interactionId);
    },
    [current],
  );

  const skip = useCallback(() => {
    // 跳过 = 先不回答,继续下一题(或收起)。交互保持 pending,徽标仍在,
    // 过期由服务器决定。confirm 的「拒绝」在题目区,与跳过不重复。
    if (index < stack.length - 1) goTo(index + 1, 1);
    else closeSheet();
  }, [index, stack.length, goTo, closeSheet]);

  if (!open) return null;

  return (
    <div className="ixsheet-root" role="dialog" aria-modal="true" aria-label={t("interaction.sheetTitle")}>
      {/* 背景虚化 + 轻压暗化 —— 转录仍可辨认,弹层才是焦点 */}
      <motion.div
        className="ixsheet-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={closeSheet}
      />

      <motion.div
        className="ixsheet"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "spring", stiffness: 380, damping: 38 }}
        drag="y"
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.5 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 96 || info.velocity.y > 700) closeSheet();
        }}
      >
        {/* 抓柄 */}
        <div className="ixsheet-handle" aria-hidden="true" />

        {/* 头部:题目序号 + 剩余时间 + 关闭 */}
        <div className="ixsheet-head">
          <div className="ixsheet-head-left">
            <span className="ixsheet-title">
              <MessageSquare size={14} aria-hidden="true" />
              {t("interaction.sheetTitle")}
            </span>
            {current && (
              <span className="ixsheet-count">
                {t("interaction.questionOf", { current: index + 1, total: stack.length })}
              </span>
            )}
          </div>
          {current && <CountdownChip interaction={current} />}
          <button
            type="button"
            className="ixsheet-close"
            onClick={closeSheet}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        {/* 进度分段条 —— 答过即灭,当前高亮 */}
        {stack.length > 1 && (
          <div className="ixsheet-segs" aria-hidden="true">
            {stack.map((ix, i) => (
              <span
                key={ix.interactionId}
                className={`ixsheet-seg${i === index ? " on" : ""}${answeredRef.current.has(ix.interactionId) ? " done" : ""}`}
              />
            ))}
          </div>
        )}

        {/* 题目内容 —— 横滑换题,direction-aware 过渡 */}
        <div className="ixsheet-body">
          <AnimatePresence mode="popLayout" custom={direction} initial={false}>
            {current && !finishing && (
              <motion.div
                key={current.interactionId}
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ type: "spring", stiffness: 400, damping: 34 }}
                drag={typing ? false : "x"}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.16}
                onDragEnd={(_, info) => {
                  if (info.offset.x < -64 || info.velocity.x < -500) next();
                  else if (info.offset.x > 64 || info.velocity.x > 500) prev();
                }}
              >
                <QuestionCard
                  interaction={current}
                  draft={drafts[current.interactionId] ?? {}}
                  onDraft={(patch) => setDraft(current.interactionId, patch)}
                  onAnswer={(value) => void answer(value)}
                  onTypingChange={setTyping}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* 全部答完 —— 短暂确认态,衔接下一问或收起 */}
          <AnimatePresence>
            {finishing && (
              <motion.div
                className="ixsheet-done"
                initial={{ opacity: 0, scale: 0.8, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ type: "spring", stiffness: 420, damping: 28 }}
              >
                <span className="ixsheet-done-ring">
                  <Check size={26} aria-hidden="true" />
                </span>
                <span className="ixsheet-done-label">{t("interaction.done")}</span>
                <span className="ixsheet-done-sub">{t("interaction.finishing")}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 底部:回退 / 跳过 / 提交 */}
        {current && !finishing && (
          <div className="ixsheet-foot">
            <button
              type="button"
              className="ixsheet-foot-btn ghost"
              onClick={prev}
              disabled={index === 0}
              aria-label={t("interaction.prev")}
            >
              <ChevronLeft size={16} aria-hidden="true" />
              {t("interaction.prev")}
            </button>

            <button
              type="button"
              className="ixsheet-foot-btn skip"
              onClick={skip}
            >
              {t("interaction.skip")}
            </button>

            {current.kind !== "confirm" && (
              <SubmitButton interaction={current} draft={drafts[current.interactionId] ?? {}} onAnswer={(value) => void answer(value)} />
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
});

// ----------------------------------------------------------------
// 单题内容
// ----------------------------------------------------------------

function QuestionCard({
  interaction,
  draft,
  onDraft,
  onAnswer,
  onTypingChange,
}: {
  interaction: RemoteInteractionSnapshot;
  draft: QuestionDraft;
  onDraft: (patch: Partial<QuestionDraft>) => void;
  onAnswer: (value: boolean | string) => void;
  onTypingChange: (typing: boolean) => void;
}) {
  const isResponding = useInteractionStore((s) =>
    s.responding.has(interaction.interactionId),
  );
  const expired = useExpiryCountdown(interaction.expiresAt) === 0;
  const locked = isResponding || expired;
  const hasSelection = draft.selected !== undefined || (draft.customOpen && Boolean(draft.text?.trim()));
  const hasText = Boolean(draft.text?.trim());

  return (
    <div className="ixsheet-card">
      {/* Pi 的提问 —— 弹层的视觉重心 */}
      <p className="ixsheet-prompt">{interaction.prompt}</p>

      {expired && (
        <p className="ixsheet-expired">{t("state.interactionExpiredDetail")}</p>
      )}

      {/* confirm:拒绝单击可达,批准长按 —— 与桌面端同一套误触防护 */}
      {interaction.kind === "confirm" && !expired && (
        <div className="ixsheet-confirm">
          <button
            type="button"
            className="btn-block outline"
            disabled={locked}
            onClick={() => onAnswer(false)}
          >
            {t("interaction.reject")}
          </button>
          <LongPressButton
            disabled={locked}
            onConfirm={() => onAnswer(true)}
            hint={t("interaction.approve")}
          >
            {t("interaction.approve")}
          </LongPressButton>
        </div>
      )}

      {/* select:先选后提交,反悔只需再点一次;「其它」走自由输入 */}
      {interaction.kind === "select" && !expired && (
        <div className="ixsheet-options">
          {(interaction.options ?? []).map((opt) => {
            const selected = draft.selected === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                className={`ixsheet-opt${selected ? " sel" : ""}`}
                disabled={locked}
                onClick={() => onDraft({ selected: opt.value, customOpen: false })}
              >
                <span className="ixsheet-opt-radio" aria-hidden="true">
                  {selected && <Check size={12} />}
                </span>
                <span className="ixsheet-opt-text">
                  <span className="ixsheet-opt-label">{opt.label}</span>
                  {opt.value !== opt.label && (
                    <span className="ixsheet-opt-value">{opt.value}</span>
                  )}
                </span>
              </button>
            );
          })}

          {!draft.customOpen ? (
            <button
              type="button"
              className="ixsheet-opt other"
              disabled={locked}
              onClick={() => onDraft({ customOpen: true, selected: undefined })}
            >
              {t("interaction.otherValue")}
            </button>
          ) : (
            <div className="ixsheet-custom">
              <input
                className="ixsheet-input"
                value={draft.text ?? ""}
                onChange={(e) => onDraft({ text: e.target.value })}
                onFocus={() => onTypingChange(true)}
                onBlur={() => onTypingChange(false)}
                disabled={locked}
                placeholder={t("interaction.inputPlaceholder")}
              />
            </div>
          )}
        </div>
      )}

      {/* input / editor:单行与多行,Enter 快捷提交 */}
      {(interaction.kind === "input" || interaction.kind === "editor") && !expired && (
        <div className="ixsheet-custom">
          {interaction.kind === "editor" ? (
            <textarea
              className="ixsheet-textarea"
              value={draft.text ?? ""}
              onChange={(e) => onDraft({ text: e.target.value })}
              onFocus={() => onTypingChange(true)}
              onBlur={() => onTypingChange(false)}
              disabled={locked}
              rows={6}
              placeholder={t("interaction.editorPlaceholder")}
            />
          ) : (
            <input
              className="ixsheet-input"
              value={draft.text ?? ""}
              onChange={(e) => onDraft({ text: e.target.value })}
              onFocus={() => onTypingChange(true)}
              onBlur={() => onTypingChange(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && hasText) {
                  onAnswer(draft.text!.trim());
                }
              }}
              disabled={locked}
              placeholder={t("interaction.inputPlaceholder")}
            />
          )}
        </div>
      )}

      {/* select 提交提示 —— 提交按钮在底部栏 */}
      {interaction.kind === "select" && (
        <p className="ixsheet-select-hint">
          {hasSelection
            ? t("interaction.selectHintReady")
            : t("interaction.selectHint")}
        </p>
      )}
    </div>
  );
}

function SubmitButton({
  interaction,
  draft,
  onAnswer,
}: {
  interaction: RemoteInteractionSnapshot;
  draft: QuestionDraft;
  onAnswer: (value: string) => void;
}) {
  const isResponding = useInteractionStore((s) =>
    s.responding.has(interaction.interactionId),
  );
  const expired = useExpiryCountdown(interaction.expiresAt) === 0;

  const ready =
    interaction.kind === "select"
      ? draft.selected !== undefined || (draft.customOpen && Boolean(draft.text?.trim()))
      : Boolean(draft.text?.trim());

  return (
    <button
      type="button"
      className="ixsheet-foot-btn primary"
      disabled={!ready || isResponding || expired}
      onClick={() => {
        if (interaction.kind === "select") {
          onAnswer((draft.customOpen ? draft.text : draft.selected)!.trim());
        } else {
          onAnswer(draft.text!.trim());
        }
      }}
    >
      {isResponding ? t("common.loading") : t("interaction.submit")}
    </button>
  );
}

/** 当前题剩余时间 —— 最后一分钟红色脉冲。 */
function CountdownChip({ interaction }: { interaction: RemoteInteractionSnapshot }) {
  const remaining = useExpiryCountdown(interaction.expiresAt);
  if (remaining === null) return null;
  return (
    <span className={`ixsheet-cd${remaining === 0 ? " expired" : remaining < 60 ? " urgent" : ""}`}>
      {formatCountdown(remaining)}
    </span>
  );
}
