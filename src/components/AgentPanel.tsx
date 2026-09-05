"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Virtuoso, type VirtuosoHandle, type Components } from "react-virtuoso";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@appica/ui-react/collapsible";
import { Spinner } from "@appica/ui-react/spinner";
import { AGENT_PANEL_WIDTH_DEFAULT, useUI } from "@/lib/store";
import {
  effectiveBindings,
  isMacPlatform,
  matchesBinding,
  shortcutById,
} from "@/lib/shortcuts";
import { useChat, getChatStore, type ChatMessage, type DeliveryMode } from "@/lib/pi/chat";
import { usePi, getPiStore } from "@/lib/pi/store";
import { useSessions, type ChatSessionMeta } from "@/lib/pi/sessions";
import { focusSession, useTaskContext } from "@/lib/pi/task-context";
import { usePlanProgress } from "@/lib/pi/plan";
import { useTurnChanges } from "@/lib/pi/turn";
import { useFileInspector } from "@/lib/file-inspector";
import { useRemoteConversations } from "@/lib/remote-conversations/store";
import { useSubagents } from "@/lib/pi/subagents";
import { useExtUi } from "@/lib/pi/ext-ui";
import { useT } from "@/lib/i18n";
import { composeLongTextPrompt, isLongText } from "@/lib/long-text";
import {
  filterSlashCommands,
  runBuiltinCommand,
  type SlashItem,
} from "@/lib/pi/commands";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { MessageBubble, hasRenderableContent } from "./MessageBubble";
import { RemoteConversationPanel } from "./RemoteConversationPanel";
import { ActivityLine, PiSpark, ShimmerText } from "./ActivityLine";import { PiMark } from "./PiMark";
import { ComposerInput } from "./ComposerInput";
import { RetryBanner } from "./RetryBanner";
import { ExtStatusLine, ExtWidgets } from "./ExtensionSurfaces";
import { SessionHistoryMenu } from "./SessionHistoryMenu";
import { ExecutionTargetPicker } from "./ExecutionTargetPicker";
import { GitBranchLabel } from "./GitBranchLabel";
import { RemoteTaskBadge } from "./RemoteTaskBadge";
import { IconButton, SectionLabel } from "./primitives";
import {
  Square,
  ArrowUp,
  ArrowDown,
  ChevronRight,
  FileDiff,
  SquarePen,
  X,
} from "lucide-react";

/**
 * The welcome state settling into a conversation: the two centering spacers
 * shrink, the brand collapses, and the composer rides down on the space they
 * give up. One spring shared by all three — separate transitions read as the
 * pieces arriving at slightly different times rather than as one movement.
 * Matches `springPanel` in app/page.tsx so panel motion is consistent.
 */
const DESCEND_SPRING = { type: "spring" as const, stiffness: 300, damping: 30 };
/** Same layout change with the motion removed, for reduced-motion users. */
const DESCEND_INSTANT = { duration: 0 };

/**
 * Right rail — the chat surface.
 *
 * There is one surface and two kinds of conversation on it: local sessions
 * (this component) and conversations started on a paired phone
 * (`RemoteConversationPanel`). The sidebar owns which one is focused; a remote
 * selection wins because it can only be set by an explicit click, and it is
 * cleared the moment a local session takes focus back.
 */
export function AgentPanel({ width }: { width?: number } = {}) {
  const remoteSelectedId = useRemoteConversations((s) => s.selectedId);
  if (remoteSelectedId !== null) return <RemoteConversationPanel width={width} />;
  return <LocalAgentPanel width={width} />;
}

/** The local pi conversation stream. */
function LocalAgentPanel({ width }: { width?: number }) {
  const { agentRunning, startDemo } = useUI();
  const { messages, streaming, send, steer, followUp, abort, queue } = useChat();
  /** how ⌘⏎ delivers a message typed while a turn is already running */
  const [delivery, setDelivery] = useState<DeliveryMode>("steer");
  const retrying = useChat((s) => {
    for (const st of s.activeRetries.values()) if (st.status === "loading") return true;
    return false;
  });
  const piStatus = usePi((s) => s.status);
  const piCommands = usePi((s) => s.commands);
  const [draft, setDraft] = useState("");
  const [longTextDraft, setLongTextDraft] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [isAtTop, setIsAtTop] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // "Waiting for first token": streaming is on, but the AI hasn't produced any
  // visible content yet (no assistant text/thinking/tools/error). This is the
  // gap between sending and the first streamed character — show the Pi loader.
  const waitingForFirstToken = streaming && (() => {
    const last = messages[messages.length - 1];
    if (!last) return true;
    if (last.role === "user") return true;
    return !last.text && !last.thinking && last.tools.length === 0 && !last.isError;
  })();
  const t = useT();

  /* What the transcript actually shows. pi opens an assistant message per
     `message_start` and several of them render nothing (tool-result carriers,
     no-op start/end pairs) — each one still cost its own Virtuoso row and its
     own vertical margin, which is what put unexplained dead space between two
     groups of tool rows. Dropping them here also keeps `animateIn` pointed at
     the last *visible* message rather than an invisible one. */
  const visible = useMemo(() => messages.filter(hasRenderableContent), [messages]);

  /* Nothing to show and nothing on the way: the brand block takes the panel and
     the composer rises to the centerline. `agentRunning` is part of it so a turn
     that has been dispatched but hasn't rendered its first row yet doesn't flash
     the welcome state back up. */
  const isEmpty = visible.length === 0 && !agentRunning && !streaming;

  /* The descent is a position change, which is exactly what vestibular triggers
     are about — so honor the OS setting and let it cut instead. */
  const reducedMotion = useReducedMotion();
  const descend = reducedMotion ? DESCEND_INSTANT : DESCEND_SPRING;

  /* Sending pins the transcript to the bottom, whatever it was showing before.
     `followOutput` can't cover this: it only follows a view that is *already* at
     the bottom, and typing is exactly what takes the view off it — the composer
     grows from 2 rows to 12 as the draft wraps, each row shrinking the scroller
     above it while its scrollTop stays put, so a few lines of typing is enough to
     push the last message under the fold. Submitting then appended the reply into
     that gap and left it there.

     Keyed on the last *user* message id, so every path that hands pi a prompt is
     covered (composer, palette, zen mode, steer, follow-up) without each having to
     remember to scroll — and a plain token arriving mid-reply doesn't re-pin a
     reader who has deliberately scrolled away. */
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (lastUserId === null) return;
    /* Three jumps across successive frames, not one: this commit only adds the
       bubble. The row's real height lands when Virtuoso measures it, and the
       composer collapsing back to 2 rows (its own effect, on the cleared draft)
       grows the scroller again — both move the bottom after we would have hit it. */
    const jump = () => virtuosoRef.current?.scrollTo({ top: Number.MAX_SAFE_INTEGER });
    jump();
    let second = 0;
    const first = requestAnimationFrame(() => {
      jump();
      second = requestAnimationFrame(jump);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [lastUserId]);

  /* an extension pushed text into the editor (set_editor_text) — pi treats this
     as replacing the draft, so mirror that and consume it so it applies once. */
  const extEditorText = useExtUi((s) => s.editorText);
  useEffect(() => {
    if (extEditorText === null) return;
    if (isLongText(extEditorText)) {
      setLongTextDraft(extEditorText);
      setDraft("");
    } else {
      setLongTextDraft(null);
      setDraft(extEditorText);
    }
    useExtUi.getState().clearEditorText();
  }, [extEditorText]);

  /** Lift images into attachments and large plain-text pastes into a document chip. */
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length > 0) {
      e.preventDefault();
      for (const file of files) {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            setAttachments((prev) => [...prev, reader.result as string]);
          }
        };
        reader.readAsDataURL(file);
      }
      return;
    }

    const pastedText = e.clipboardData.getData("text/plain");
    if (!isLongText(pastedText)) return;

    e.preventDefault();
    setLongTextDraft((current) =>
      current ? `${current}\n\n${pastedText}` : pastedText
    );
  };

  /* slash-command menu — open while the draft is "/<partial-name>" */
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashQuery =
    !slashDismissed && draft.startsWith("/") && !draft.includes(" ")
      ? draft.slice(1)
      : null;
  const slashItems = useMemo(
    () =>
      slashQuery !== null
        ? filterSlashCommands(slashQuery, piCommands, t)
        : [],
    [slashQuery, piCommands, t]
  );
  const slashOpen = slashItems.length > 0;

  useEffect(() => setSlashIndex(0), [slashQuery]);

  /** click / ⏎ on a menu row — auto-fill the composer with the command */
  const pickSlash = (item: SlashItem) => {
    setDraft(`/${item.name} `);
  };

  /**
   * Copy the last assistant message (⌘⇧C by default, rebindable in settings).
   *
   * Bound to this container rather than the window on purpose: the terminal ships
   * the same chord for its own copy, and only one of the two can hold focus.
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const command = shortcutById("copyLastReply");
      if (!command) return;
      const { shortcutOverrides } = useUI.getState();
      const mac = isMacPlatform();
      const hit = effectiveBindings(command, shortcutOverrides).some((b) =>
        matchesBinding(e, b, mac)
      );
      if (hit) {
        e.preventDefault();
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.text);
        if (lastAssistant?.text) {
          navigator.clipboard.writeText(lastAssistant.text).catch(console.error);
        }
      }
    };
    const container = containerRef.current;
    if (container) {
      container.addEventListener('keydown', handleKeyDown);
      return () => container.removeEventListener('keydown', handleKeyDown);
    }
  }, [messages]);

  /* No auto-send-on-idle effect here on purpose: messages typed during a run go
     straight to pi as `steer`/`follow_up`, and pi executes them itself. Re-sending
     them locally when `streaming` flipped false is what used to double-send. */

  const submit = (alt = false) => {
    const text = composeLongTextPrompt(longTextDraft, draft);
    const images = attachments;
    if (!text && images.length === 0) return;
    setDraft("");
    setLongTextDraft(null);
    setAttachments([]);
    if (text.toLowerCase() === "demo") {
      if (!agentRunning) startDemo(); // local streaming-edit showcase
      return;
    }
    if (text.toLowerCase() === "agents") {
      useSubagents.getState().runDemo(); // parallel subagent showcase
      return;
    }
    if (runBuiltinCommand(text)) return; // built-ins act locally

    // A turn is already in flight: hand the message to pi rather than sending a
    // second `prompt`. `steer` cuts into the running turn, `followUp` waits for
    // it — ⌘⇧⏎ (`alt`) picks whichever the toggle is not set to.
    if (streaming) {
      const mode: DeliveryMode = alt
        ? delivery === "steer"
          ? "followUp"
          : "steer"
        : delivery;
      void (mode === "steer" ? steer(text, images) : followUp(text, images));
      return;
    }

    send(text, images); // extension commands & plain prompts go to pi
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      // ⌘/Ctrl+↩ always sends, even with the menu open — the menu only claims
      // the plain Enter family so it can win over an `Enter`-to-send preference.
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault();
        pickSlash(slashItems[slashIndex] ?? slashItems[0]);
        return;
      }
      if (e.key === "Escape") {
        setSlashDismissed(true);
        return;
      }
    }
    // Note: the send shortcut itself is handled in ComposerInput, which runs
    // this handler first and stands down if it called preventDefault().
  };

  const busy = streaming || agentRunning || retrying;

  /* The plan's progress rides the status line rather than claiming a row of its
     own — see the header. `activeForm` is pi's present-tense phrasing for the step
     it is on, which is the most specific true answer to "what is it doing"; the
     label truncates from the right, so a long step gives way rather than pushing
     the controls off the edge. */
  const taskId = useTaskContext((s) => s.activeTaskId);
  const plan = usePlanProgress(taskId);
  const statusText = useMemo(() => {
    const base = busy
      ? t("agent.working")
      : t("agent.statusLine", { status: t(`status.${piStatus}`) });
    if (plan.total === 0) return base;
    const progress = t("plan.progress", {
      done: String(plan.done),
      total: String(plan.total),
    });
    const step = plan.active?.activeForm ?? plan.active?.subject;
    return step ? `${base} · ${progress} · ${step}` : `${base} · ${progress}`;
  }, [busy, piStatus, plan, t]);

  const canScroll = !(isAtTop && isAtBottom);
  const scrollToEdge = () => {
    virtuosoRef.current?.scrollTo({
      top: isAtBottom ? 0 : Number.MAX_SAFE_INTEGER,
      behavior: "smooth",
    });
  };

  return (
    <aside
      ref={containerRef}
      className="material"
      tabIndex={-1}
      style={{
        /* An explicit px width, not 100%: the wrapper animates its own width to
           open and close the rail, and a percentage would make the transcript
           reflow through every frame of that instead of being clipped. */
        width: width ?? AGENT_PANEL_WIDTH_DEFAULT,
        height: "100%",
        borderLeft: "1px solid var(--separator)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        outline: "none",
      }}
    >
      {/* header — status + session history / new-session entry points */}
      <div style={{ display: "flex", alignItems: "center", paddingRight: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* The status line already answers "what is pi doing"; the plan's
              progress and current step are the same question answered in more
              detail, so they ride here instead of claiming their own row. Clicking
              it opens the full checklist — nothing about it costs the transcript
              any height. */}
          <SectionLabel
            onClick={
              plan.total > 0
                ? () => useFileInspector.getState().openTask("plan")
                : undefined
            }
            title={plan.total > 0 ? t("plan.open") : undefined}
          >
            {statusText}
          </SectionLabel>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            paddingTop: 8,
            // the label truncates; the controls do not
            flexShrink: 0,
          }}
        >
          {/* Session list in a menu, not a sidebar toggle: work and zen mode
              can't render the sidebar at all, so a toggle there flips a flag
              nothing reads and the button reads as dead. */}
          <TurnChangesChip width={width} />
          <GitBranchLabel width={width} />
          <ExecutionTargetPicker />
          <RemoteTaskBadge />
          <SessionHistoryMenu />
          <IconButton
            label={t("agent.newSession")}
            onClick={() => useSessions.getState().newSession()}
          >
            <SquarePen size={14} />
          </IconButton>
        </div>
      </div>

      {/* extension setStatus lines — live status pushed by pi extensions */}
      <ExtStatusLine />

      {/* background tasks — other conversations running in parallel. Compact
          pills: name + current tool + per-task stop; click to focus. */}
      <BackgroundTasksStrip />

      {/* Idle: the transcript has nothing to show, so it yields its space to the
          two spacers that lift the brand + composer to the vertical centerline.
          `flex: 1` would otherwise keep the empty scroller filling the panel and
          pin the composer to the bottom. Virtuoso stays mounted either way —
          unmounting it would drop the scroll position on the first token. */}
      <div
        style={{
          position: "relative",
          flex: isEmpty ? "0 0 0px" : 1,
          minHeight: 0,
          overflow: isEmpty ? "hidden" : undefined,
        }}
      >
        <Virtuoso<ChatMessage>
          ref={virtuosoRef}
          data={visible}
          atTopStateChange={setIsAtTop}
          atBottomStateChange={setIsAtBottom}
          // Follow new content only while the view is already at the bottom —
          // scrolling up to read history is never interrupted. `auto` (not
          // `smooth`): a smooth scroll animates for ~1s, which tokens outpace, so
          // the view falls behind its own target and drifts off the bottom. An
          // instant jump per chunk is what actually reads as staying pinned.
          //
          // Deliberately not gated on `streaming` any more. Messages also land
          // outside a run — a connection error, a queued follow-up's echo, a
          // transcript restored on session switch — and those used to append below
          // the fold with nothing to bring them into view.
          followOutput={(atBottom) => (atBottom ? "auto" : false)}
          // Virtuoso's stock 4px threshold is too tight for this transcript.
          // MessageBubble spaces itself with margins that row measurement rounds
          // off (see the flow-root note in itemContent), so the scroller can sit a
          // few px short of its own end and report `atBottom: false` while it looks
          // parked at the bottom — which silently disables the follow above for the
          // rest of the session. 48px absorbs that drift and is still far under one
          // message height, so a deliberate scroll up still detaches.
          atBottomThreshold={48}
          // buffer items above/below the viewport so fast scrolls stay filled.
          increaseViewportBy={{ top: 600, bottom: 600 }}
          computeItemKey={(_index, m) => m.id}
          className="material"
          style={{ height: "100%" }}
          components={
            {
              // Top of the scroll area (does NOT stick) — only the empty-state
              // hint. Neither subagents nor tool activity get a surface here:
              // every tool call is already a row inside the assistant message
              // that made it (see ToolRow in MessageBubble), and subagents are
              // followed and opened from those same rows. A strip up here used
              // to mirror the very same `tool_execution_*` stream, so a running
              // command was drawn twice — once at the top of the scroll area,
              // once in place.
              //
              // Renders nothing once there is a transcript: an empty wrapper
              // would still hand Virtuoso its padding as header height, leaving
              // a dead band above the first message.
              // The empty state is no longer a scroll-area header — it is the
              // centered brand block below, which sits outside Virtuoso so the
              // composer can rise to meet it.
              Header: () => null,
              // Bottom of the scroll area — one compact line while the turn has
              // produced nothing visible yet, so it reads as the first row of the
              // activity list rather than a loading panel.
              Footer: () => (
              <div className="sd-measure" style={{ display: "flow-root", padding: "0 12px 6px" }}>
                <AnimatePresence>
                  {waitingForFirstToken && (
                    <motion.div
                      initial={{ opacity: 0, y: -3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ type: "spring", stiffness: 420, damping: 32 }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "4px 2px",
                      }}
                    >
                      <PiSpark size={13} />
                      <ShimmerText style={{ fontSize: 12, lineHeight: 1.45 }}>
                        {t("agent.loading")}
                      </ShimmerText>
                    </motion.div>
                  )}
                </AnimatePresence>
                {/* the turn's closing line — what it changed, and a way in */}
                <TurnChangesRow busy={busy} />
              </div>
            ),
            } satisfies Components<ChatMessage>
          }
          itemContent={(index, m) => (
            // Only the latest message plays the entrance animation — historical
            // messages use initial={false} so virtualized re-mounts on scroll
            // don't replay the fade-in.
            //
            // `flow-root` is load-bearing, not cosmetic. Virtuoso sizes each row with
            // getBoundingClientRect(), which never includes margins. MessageBubble
            // spaces itself with vertical margins and this wrapper has no vertical
            // padding, so without a block formatting context those margins collapse
            // straight out of the box Virtuoso measures. Every row then under-reports
            // by ~7px: the bottom spacer comes out short, scrollHeight grows as you
            // arrive, and the transcript can never reach its own end.
            <div className="sd-measure" style={{ display: "flow-root", padding: "0 12px" }}>
              <MessageBubble
                key={m.id}
                m={m}
                animateIn={index === visible.length - 1}
                // continues the previous assistant message's turn — see the
                // margin note in AssistantMessage
                tight={visible[index - 1]?.role === "assistant"}
              />
            </div>
          )}
        />

        {visible.length > 0 && canScroll && (
          <div
            style={{
              position: "absolute",
              right: 14,
              bottom: 12,
              zIndex: 2,
              border: "1px solid var(--separator)",
              borderRadius: 8,
              background: "var(--material-thick)",
              boxShadow: "var(--shadow-md)",
            }}
          >
            <IconButton
              label={t(isAtBottom ? "agent.scrollTop" : "agent.scrollBottom")}
              onClick={scrollToEdge}
            >
              {isAtBottom ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </IconButton>
          </div>
        )}
      </div>

      {/* Top half of the idle centering, paired with the spacer below the
          composer: together they hold the free space that lifts the brand and
          input to the centerline.
          Always mounted and animated by flexGrow rather than conditionally
          rendered. Removing them outright made the composer snap to the bottom
          in a single frame; shrinking them hands that space to the transcript
          over one spring, and the composer descends as an ordinary layout
          result. Deliberately NOT a `layout` prop on the composer itself: it
          wraps a textarea that changes height whenever the draft wraps, and
          Framer would spring on every one of those too. */}
      <motion.div
        aria-hidden
        animate={{ flexGrow: isEmpty ? 1 : 0 }}
        transition={descend}
        style={{ flexBasis: 0, minHeight: 0 }}
      />

      <AnimatePresence initial={false}>
        {isEmpty && (
          <motion.div
            key="empty-brand"
            initial={{ opacity: 0, y: 8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            /* Collapses its height on the way out, on the same spring as the
               spacers. Fading alone left it holding its box while the spacers
               shrank underneath it, so it visibly lurched upward mid-fade —
               two competing motions in one frame. Height (not transform) for
               the same reason ExtStatusLine does: the box has to stop
               occupying flow space, which a transform never does. */
            exit={{ opacity: 0, height: 0 }}
            transition={descend}
            className="sd-measure"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              padding: "0 12px 18px",
              flexShrink: 0,
              overflow: "hidden",
            }}
          >
            <PiMark size={26} style={{ color: "var(--text-primary)", opacity: 0.9 }} />
            <span
              style={{
                fontFamily: "var(--font-cormorant)",
                fontStyle: "italic",
                fontSize: 30,
                letterSpacing: "0.06em",
                color: "var(--text-primary)",
                opacity: 0.85,
                lineHeight: 1,
              }}
            >
              {t("agent.emptyTitle")}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* composer — measured like the transcript so the input lines up with the
          messages it answers, while the panel's own surface stays full width */}
      <div className="sd-measure" style={{ position: "relative", flexShrink: 0 }}>
        {/* "/" surfaces built-in + extension commands; a click fills the input */}
        <SlashCommandMenu
          open={slashOpen}
          items={slashItems}
          activeIndex={slashIndex}
          onHover={setSlashIndex}
          onSelect={pickSlash}
        />
        {/* inline retry status — lives in the panel, not a bottom-fixed toast */}
        <div style={{ padding: "0 12px" }}>
          <RetryBanner />
          {/* extension widgets pinned above the editor */}
          <ExtWidgets placement="aboveEditor" />
        </div>
        <ComposerInput
          draft={draft}
          setDraft={(value) => {
            setDraft(value);
            setSlashDismissed(false); // typing re-opens an escaped menu
          }}
          longTextDraft={longTextDraft}
          setLongTextDraft={setLongTextDraft}
          attachments={attachments}
          setAttachments={setAttachments}
          streaming={streaming}
          retrying={retrying}
          busy={busy}
          onSubmit={submit}
          onAbort={abort}
          onKeyDown={onComposerKeyDown}
          onPaste={onComposerPaste}
          queue={queue}
          delivery={delivery}
          onDeliveryChange={setDelivery}
          seamless={isEmpty}
        />
        {/* extension widgets pinned below the editor */}
        <div style={{ padding: "0 12px 8px" }}>
          <ExtWidgets placement="belowEditor" />
        </div>
      </div>

      {/* Bottom half of the idle centering — see the spacer above the brand.
          Under 1 so the group sits a little above true center, which is what
          reads as centered once the composer's own height is in the balance. */}
      <motion.div
        aria-hidden
        animate={{ flexGrow: isEmpty ? 0.85 : 0 }}
        transition={descend}
        style={{ flexBasis: 0, minHeight: 0 }}
      />
    </aside>
  );
}

/* ── background running-task strip ── */

/** Derive the live tool name for a conversation, if any is mid-flight. */
function lastActiveTool(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tool = messages[i].tools.find((t) => t.status === "running");
    if (tool) return tool.name;
  }
  return null;
}

/**
 * Compact strip of every background conversation that is busy (running or
 * waiting on input). Only the non-focused tasks show here — the focused one is
 * already on screen. Click a pill to focus that task; the stop button aborts it
 * without switching away.
 */
function BackgroundTasksStrip() {
  const sessions = useSessions((s) => s.sessions);
  const activeId = useSessions((s) => s.activeId);
  return (
    <div style={{ padding: "0 12px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
      {sessions
        .filter((s) => s.id !== activeId)
        .map((s) => (
          <BackgroundTaskPill key={s.id} session={s} />
        ))}
    </div>
  );
}

function BackgroundTaskPill({ session }: { session: ChatSessionMeta }) {
  const t = useT();
  const streaming = getChatStore(session.id)((st) => st.streaming);
  const waiting = getChatStore(session.id)((st) => st.waiting);
  const piRunning = getPiStore(session.id)((st) => st.status === "running");
  const lastTool = getChatStore(session.id)((st) => lastActiveTool(st.messages));

  if (!streaming && !piRunning && !waiting) return null;
  const name = session.name.trim() || t("session.untitled");
  const label = waiting
    ? t("agent.backgroundWaiting")
    : lastTool
      ? lastTool
      : t("agent.backgroundWorking");

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => focusSession(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          focusSession(session.id);
        }
      }}
      title={name}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 6px 5px 9px",
        borderRadius: 8,
        border: "1px solid var(--separator)",
        background: "color-mix(in srgb, var(--accent) 6%, transparent)",
        fontSize: 12,
        cursor: "pointer",
        color: "var(--text-secondary)",
      }}
    >
      <motion.span
        initial={{ opacity: 0.4 }}
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flexShrink: 0,
          background: waiting ? "var(--warning)" : "var(--accent)",
        }}
      />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <b style={{ color: "var(--text-primary)", fontWeight: 600 }}>{name}</b>
        <span style={{ opacity: 0.7 }}>{` · ${label}`}</span>
      </span>
      <motion.button
        whileTap={{ scale: 0.9 }}
        title={t("agent.stop")}
        aria-label={t("agent.stop")}
        onClick={(e) => {
          e.stopPropagation();
          getChatStore(session.id).getState().abort();
        }}
        style={{
          border: "none",
          background: "transparent",
          color: "var(--text-tertiary)",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          width: 18,
          height: 18,
          borderRadius: 4,
        }}
      >
        <Square size={11} fill="currentColor" />
      </motion.button>
    </div>
  );
}

/* ── this turn's changes ── */

/**
 * The turn's closing line: how much it changed, and the way into the panel that
 * lists it.
 *
 * In the scroll area's footer rather than inside the last message — "the turn is
 * over" is not a property of any one message, since pi splits a turn across
 * several, and the footer is the one place that sits below all of them.
 *
 * Only ever describes the turn that just ran. The diffs behind it are held in
 * memory only, so a transcript restored from history has nothing to summarize and
 * this stays out of the way rather than reporting zero.
 */
function TurnChangesRow({ busy }: { busy: boolean }) {
  const t = useT();
  const taskId = useTaskContext((s) => s.activeTaskId);
  const changes = useTurnChanges(taskId);
  const active = useFileInspector((s) => s.open && s.segment === "task");
  if (busy || changes.files.length === 0) return null;

  const files =
    changes.files.length === 1
      ? t("turn.oneFile")
      : t("turn.files", { count: String(changes.files.length) });

  return (
    <ActivityLine
      status="done"
      toolName="write"
      title={t("turn.row", {
        files,
        added: `${changes.approx ? "~" : ""}+${changes.added}`,
        removed: `−${changes.removed}`,
      })}
      onClick={() => useFileInspector.getState().openTask("changes")}
      active={active}
      ariaLabel={t("turn.open")}
      trailing={<ChevronRight size={12} />}
    />
  );
}

/**
 * The roll-up of what this turn has written, and the way into the panel that
 * details it. It lives in the header, so it costs the transcript no height, and it
 * renders nothing at all until there is something to report.
 *
 * Degrades with the rail's width instead of pushing its neighbours off the edge:
 * the rail's floor is 280px and this row already carries four controls. Work mode
 * passes no width — the chat is the flexible column there and has room to spare.
 */
function TurnChangesChip({ width }: { width?: number }) {
  const t = useT();
  const taskId = useTaskContext((s) => s.activeTaskId);
  const changes = useTurnChanges(taskId);
  const active = useFileInspector((s) => s.open && s.segment === "task");
  if (changes.files.length === 0) return null;

  const files =
    changes.files.length === 1
      ? t("turn.oneFile")
      : t("turn.files", { count: String(changes.files.length) });
  const added = `${changes.approx ? "~" : ""}+${changes.added}`;
  const removed = `−${changes.removed}`;
  const compact = width !== undefined && width < 380;
  const iconOnly = width !== undefined && width < 320;

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.96 }}
      onClick={() => useFileInspector.getState().openTask("changes")}
      title={t("turn.open")}
      aria-label={t("turn.row", { files, added, removed })}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        marginRight: 4,
        padding: iconOnly ? "4px 5px" : "4px 7px",
        border: "1px solid var(--separator)",
        borderRadius: 99,
        background: active
          ? "color-mix(in srgb, var(--accent) 12%, transparent)"
          : "transparent",
        color: "var(--text-tertiary)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        lineHeight: 1,
        cursor: "pointer",
        transition: "background var(--duration-fast) ease",
      }}
    >
      <FileDiff size={12} strokeWidth={1.75} />
      {iconOnly ? null : compact ? (
        <span>{changes.files.length}</span>
      ) : (
        <>
          <span style={{ color: "var(--diff-add-text)" }}>{added}</span>
          <span style={{ color: "var(--diff-remove-text)" }}>{removed}</span>
        </>
      )}
    </motion.button>
  );
}
