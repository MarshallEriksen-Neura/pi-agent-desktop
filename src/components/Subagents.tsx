"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ScrollArea } from "@appica/ui-react/scroll-area";
import { Badge } from "@appica/ui-react/badge";
import { useT } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { SUBAGENT_PANEL_WIDTH_DEFAULT } from "@/lib/store";
import { PiSpark } from "./ActivityLine";
import {
  useSubagents,
  type Subagent,
  type SubagentEvent,
  type SubagentStatus,
  type SubagentUsage,
} from "@/lib/pi/subagents";
import type { AsyncRunStatus, AsyncRunStep } from "@/lib/pi/async-runs";
import { asyncStateToStatus } from "@/lib/pi/async-runs";
import type { ReactNode } from "react";
import {
  Circle,
  Wrench,
  Sparkles,
  Activity,
  Check,
  AlertTriangle,
  X,
  FileText,
} from "lucide-react";

/* ── shared visual vocabulary ── */

const STATUS_DOT: Record<SubagentStatus, string> = {
  queued: "var(--text-tertiary)",
  running: "var(--agent-thinking)",
  done: "var(--success)",
  error: "var(--danger)",
};

const KIND_ICON: Record<SubagentEvent["kind"], ReactNode> = {
  thinking: <Circle size={11} />,
  tool: <Wrench size={11} />,
  text: <Sparkles size={11} />,
  status: <Activity size={11} />,
};

function StatusDot({ status }: { status: SubagentStatus }) {
  return (
    <motion.span
      animate={
        status === "running"
          ? { scale: [1, 1.3, 1], opacity: [1, 0.6, 1] }
          : { scale: 1, opacity: 1 }
      }
      transition={
        status === "running"
          ? { repeat: Infinity, duration: 1.2, ease: "easeInOut" }
          : { type: "spring", stiffness: 400, damping: 20 }
      }
      style={{
        width: 8,
        height: 8,
        borderRadius: 99,
        flexShrink: 0,
        background: STATUS_DOT[status],
        boxShadow: status === "running" ? "0 0 0 4px var(--accent-muted)" : "none",
      }}
    />
  );
}

/**
 * Wall-clock since the worker started. Shown instead of a percentage when the
 * producer reports no step count — a parallel worker has no interpolatable
 * progress, and inventing one is worse than showing the honest elapsed time.
 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{formatDuration(Math.max(0, now - since))}</>;
}

function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`;
}

/** `project` agents come from the repo — flag them wherever the card is shown. */
function SourceBadge({ source }: { source: Subagent["source"] }) {
  const t = useT();
  if (source !== "project") return null;
  return (
    <span title={t("subagents.projectHint")}>
      <Badge variant="warning" size="sm">
        {t("subagents.project")}
      </Badge>
    </span>
  );
}

/** compact token + cost readout */
function UsageLine({ usage }: { usage: SubagentUsage }) {
  const t = useT();
  const tokens = usage.input + usage.output;
  return (
    <span style={MONO_DIM}>
      {t("subagents.usage", {
        tokens: tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens),
        cost: usage.cost.toFixed(3),
        turns: String(usage.turns),
      })}
    </span>
  );
}

const MONO_DIM = {
  fontSize: 10.5,
  fontFamily: "var(--font-mono)",
  color: "var(--text-tertiary)",
} as const;

const SECTION_LABEL = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--text-tertiary)",
  margin: "14px 0 6px",
} as const;

/* ────────────────────────────────────────────────────────────────────────────
   Inspector — a docked column, not an overlay.

   The chat rail is already the rightmost column, so a floating panel would sit
   on top of the very conversation that spawned the subagent, and its backdrop
   would stop you replying while you watch. This is a peer of the sidebar and
   the rail instead: same spring, same material, resizable, and it stays put
   while you keep working. Opening it re-lays out the workspace rather than
   covering it.

   Two data sources: a polled `status.json` snapshot for detached background
   runs (the rich path), or the card itself for synchronous runs and the local
   demo. Card ids are `${toolCallId}#${stepIndex}`, which is what lets the panel
   find the snapshot and pick the right step out of it.
   ──────────────────────────────────────────────────────────────────────────── */

/** split a card id back into the tool call it belongs to and its step index */
function splitCardId(id: string): { toolCallId: string; stepIndex: number } {
  const hash = id.lastIndexOf("#");
  if (hash === -1) return { toolCallId: id, stepIndex: 0 };
  const index = Number.parseInt(id.slice(hash + 1), 10);
  return {
    toolCallId: id.slice(0, hash),
    stepIndex: Number.isFinite(index) ? index : 0,
  };
}

/** true when the inspector has something to show — drives the column's presence */
export function useSubagentPanelOpen(): boolean {
  const focusedId = useSubagents((s) => s.focusedId);
  const hasCard = useSubagents((s) =>
    focusedId ? s.agents.some((a) => a.id === focusedId) : false
  );
  const hasRun = useSubagents((s) =>
    focusedId ? s.asyncRuns[splitCardId(focusedId).toolCallId] !== undefined : false
  );
  return Boolean(focusedId) && (hasCard || hasRun);
}

export function SubagentPanel({ width }: { width?: number }) {
  const focusedId = useSubagents((s) => s.focusedId);
  const focus = useSubagents((s) => s.focus);
  const agents = useSubagents((s) => s.agents);
  const asyncRuns = useSubagents((s) => s.asyncRuns);
  const t = useT();

  const card = focusedId ? agents.find((a) => a.id === focusedId) : undefined;
  const { toolCallId, stepIndex } = focusedId
    ? splitCardId(focusedId)
    : { toolCallId: "", stepIndex: 0 };
  // A finished run's card is cleared on the next turn, but its snapshot is
  // kept — so the panel still opens from a row further up the transcript.
  const run = focusedId ? asyncRuns[toolCallId] : undefined;
  const step = run?.steps[stepIndex];

  const name = step?.agent ?? card?.name ?? "subagent";
  const status: SubagentStatus = step
    ? asyncStateToStatus(step.status ?? run?.state)
    : run && !card
      ? asyncStateToStatus(run.state)
      : (card?.status ?? "running");
  const live = status === "running";

  return (
    <aside
      aria-label={t("subagents.drawerTitle")}
      className="material"
      style={{
        width: width ?? SUBAGENT_PANEL_WIDTH_DEFAULT,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--separator)",
        flexShrink: 0,
      }}
    >
      <PanelHead
        name={name}
        status={status}
        mode={run?.mode}
        runId={run?.runId ?? card?.runId}
        onClose={() => focus(null)}
      />

      {/* Switching between siblings swaps the body, not the panel — the frame
          holds still so it reads as changing subject, not reopening. */}
      <ScrollArea
        orientation="vertical"
        scrollShadow
        style={{ flex: 1, minHeight: 0 }}
        viewportProps={{ style: { padding: "0 15px 16px" } }}
      >
        <motion.div
          key={focusedId ?? "none"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
        >
          {/* What it is doing, first — the question the panel exists to answer. */}
          {step ? (
            <CurrentAction step={step} live={live} lastUpdate={run?.lastUpdate} />
          ) : (
            live && !card?.events.length && <Starting />
          )}

          <TaskLine task={card?.task} source={card?.source} />

          <Siblings
            run={run}
            cards={agents}
            toolCallId={toolCallId}
            activeId={focusedId ?? ""}
          />

          {step ? (
            <AsyncFeed step={step} hideOutput={Boolean(run?.finalOutput)} />
          ) : (
            <CardTimeline events={card?.events ?? []} live={live} />
          )}

          {(run?.errorText ?? card?.errorText) && (
            <ErrorBox text={(run?.errorText ?? card?.errorText) as string} />
          )}

          <Result text={run?.finalOutput ?? card?.result} />

          {run?.artifacts && run.artifacts.length > 0 && (
            <Artifacts artifacts={run.artifacts} />
          )}

          {/* accounting last: useful, never the headline */}
          <RunMeta card={card} run={run} step={step} status={status} />
        </motion.div>
      </ScrollArea>
    </aside>
  );
}

function PanelHead({
  name,
  status,
  mode,
  runId,
  onClose,
}: {
  name: string;
  status: SubagentStatus;
  mode?: string;
  runId?: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "14px 12px 11px 15px",
        borderBottom: "1px solid var(--separator)",
        flexShrink: 0,
      }}
    >
      <StatusDot status={status} />
      <span
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: "var(--text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      <Badge
        variant={status === "done" ? "success" : status === "error" ? "error" : "info"}
        size="sm"
      >
        {t(`status.${status}`)}
      </Badge>
      {mode && (
        <span style={MONO_DIM} title={t("subagents.modeHint")}>
          {mode}
        </span>
      )}
      <button
        onClick={onClose}
        aria-label={t("common.close")}
        title={runId ? t("subagents.runId", { id: runId.slice(0, 8) }) : undefined}
        style={{
          marginLeft: "auto",
          border: "none",
          background: "transparent",
          color: "var(--text-tertiary)",
          cursor: "pointer",
          padding: "2px 4px",
          borderRadius: 6,
          flexShrink: 0,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** the gap between "forked" and the first status write, which is a few seconds */
function Starting() {
  const t = useT();
  return (
    <div style={{ paddingTop: 14, fontSize: 12, color: "var(--text-tertiary)" }}>
      {t("subagents.starting")}
    </div>
  );
}

function TaskLine({ task, source }: { task?: string; source?: Subagent["source"] }) {
  if (!task || task === "…") return source ? <SourceBadge source={source} /> : null;
  return (
    <div style={{ paddingTop: 12, display: "flex", alignItems: "flex-start", gap: 7 }}>
      <div
        style={{
          fontSize: 12.5,
          color: "var(--text-secondary)",
          lineHeight: 1.5,
          minWidth: 0,
        }}
      >
        {task}
      </div>
      <SourceBadge source={source} />
    </div>
  );
}

/**
 * The run's accounting, kept at the bottom: model, tokens, cost, turns,
 * wall-clock. Real information, but never the reason someone opened the panel —
 * so it sits below the work rather than above it.
 */
function RunMeta({
  card,
  run,
  step,
  status,
}: {
  card?: Subagent;
  run?: AsyncRunStatus;
  step?: AsyncRunStep;
  status: SubagentStatus;
}) {
  const t = useT();
  const model = step?.model ?? card?.model;
  const tokens = run?.tokens;
  // the producer's own duration wins once the run ends; before that it is stale
  const duration =
    step?.durationMs !== undefined && status !== "running"
      ? formatDuration(step.durationMs)
      : undefined;
  const startedAt = step?.startedAt ?? card?.startedAt;

  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 10,
        borderTop: "1px solid var(--separator)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        {model && (
          <span style={MONO_DIM}>
            {model}
            {step?.thinking ? ` · ${step.thinking}` : ""}
          </span>
        )}
        {tokens ? (
          <span style={MONO_DIM}>
            {t("subagents.tokens", {
              tokens:
                tokens.total >= 1000
                  ? `${(tokens.total / 1000).toFixed(1)}k`
                  : String(tokens.total),
            })}
          </span>
        ) : (
          card?.usage && <UsageLine usage={card.usage} />
        )}
        {run?.costUsd !== undefined && run.costUsd > 0 && (
          <span style={MONO_DIM}>${run.costUsd.toFixed(3)}</span>
        )}
        {(step?.turnCount !== undefined || step?.toolCount !== undefined) && (
          <span style={MONO_DIM}>
            {t("subagents.turnsTools", {
              turns: String(step.turnCount ?? 0),
              tools: String(step.toolCount ?? 0),
            })}
          </span>
        )}
        <span style={MONO_DIM}>
          {duration ?? (startedAt !== undefined ? <Elapsed since={startedAt} /> : null)}
        </span>
      </div>

    </div>
  );
}

/**
 * How long since the runner last wrote. A worker inside a slow tool call looks
 * identical to a dead one from the outside, so this reports the fact rather
 * than guessing which it is.
 */
const STALE_AFTER_MS = 60_000;

function Freshness({ lastUpdate }: { lastUpdate: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const idle = now - lastUpdate;
  if (idle < STALE_AFTER_MS) return null;
  return (
    <div style={{ ...MONO_DIM, marginTop: 5, color: "var(--warning)" }}>
      {t("subagents.stale", { ago: formatDuration(idle) })}
    </div>
  );
}

/**
 * The headline answer to "what is it doing right now": the newest tool call the
 * runner has recorded. Once the run ends this is its last action instead.
 */
function CurrentAction({
  step,
  live,
  lastUpdate,
}: {
  step: AsyncRunStep;
  live: boolean;
  lastUpdate?: number;
}) {
  const t = useT();
  // `currentTool` is the call in flight; `recentTools` only holds ones that have
  // already returned. Preferring it is what stops a slow tool from looking like
  // the previous one finished and nothing followed.
  const running = step.currentTool
    ? { tool: step.currentTool, args: step.currentToolArgs, since: step.currentToolStartedAt }
    : undefined;
  const last = step.recentTools[step.recentTools.length - 1];
  const shown = running ?? (last ? { tool: last.tool, args: last.args, since: undefined } : undefined);
  if (!shown) return live ? <Starting /> : null;
  return (
    <div
      style={{
        marginTop: 13,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        background: live
          ? "color-mix(in srgb, var(--accent) 7%, transparent)"
          : "var(--bg-base)",
        border: `1px solid ${live ? "color-mix(in srgb, var(--accent) 30%, transparent)" : "var(--separator)"}`,
        overflow: "hidden",
      }}
    >
      <div
        style={{ ...MONO_DIM, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}
      >
        {live && <PiSpark size={11} />}
        {live ? t("subagents.currentAction") : t("subagents.lastAction")}
        {/* how long this one call has been running — a stuck tool is visible here
            before the whole run looks stalled */}
        {live && running?.since !== undefined && (
          <span style={{ marginLeft: "auto" }}>
            <Elapsed since={running.since} />
          </span>
        )}
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={`${shown.tool}-${shown.args ?? ""}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}
        >
          <span
            style={{
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              color: "var(--text-primary)",
              flexShrink: 0,
            }}
          >
            {shown.tool}
          </span>
          {shown.args && (
            <span
              style={{
                fontSize: 11.5,
                fontFamily: "var(--font-mono)",
                color: "var(--text-secondary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                minWidth: 0,
              }}
            >
              {shown.args}
            </span>
          )}
        </motion.div>
      </AnimatePresence>

      {/* a stall belongs next to the action it is stalled on, not in a footer */}
      {live && lastUpdate !== undefined && <Freshness lastUpdate={lastUpdate} />}
    </div>
  );
}

/**
 * The other workers of the same call, so a stalled one stays visible next to
 * the rest and every one of them is reachable.
 *
 * One list, three producers: a detached run's `steps[]`, a synchronous parallel
 * fan-out's sibling cards, and the local demo. All of them key their cards
 * `${toolCallId}#${index}`, so the cards are the fallback whenever no snapshot
 * exists.
 */
function Siblings({
  run,
  cards,
  toolCallId,
  activeId,
}: {
  run?: AsyncRunStatus;
  cards: Subagent[];
  toolCallId: string;
  activeId: string;
}) {
  const focus = useSubagents((s) => s.focus);
  const t = useT();

  const rows = run
    ? run.steps.map((s, i) => ({
        id: `${toolCallId}#${i}`,
        name: s.label ? `${s.label} · ${s.agent}` : s.agent,
        status: asyncStateToStatus(s.status ?? run.state),
        turns: s.turnCount,
        tools: s.toolCount,
      }))
    : cards
        .filter((c) => c.id.startsWith(`${toolCallId}#`))
        .map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          turns: c.usage?.turns,
          tools: undefined as number | undefined,
        }));

  if (rows.length < 2) return null;

  return (
    <>
      <div style={SECTION_LABEL}>{t("subagents.steps")}</div>
      {rows.map((row) => {
        const active = row.id === activeId;
        return (
          <button
            key={row.id}
            onClick={() => focus(row.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              textAlign: "left",
              padding: "7px 9px",
              marginBottom: 4,
              borderRadius: "var(--radius-sm)",
              background: active ? "var(--accent-muted)" : "transparent",
              border: `1px solid ${active ? "var(--accent)" : "var(--separator)"}`,
              cursor: "pointer",
            }}
          >
            <StatusDot status={row.status} />
            <span
              style={{
                fontSize: 12,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {row.name}
            </span>
            {(row.turns !== undefined || row.tools !== undefined) && (
              <span style={{ ...MONO_DIM, marginLeft: "auto", flexShrink: 0 }}>
                {t("subagents.turnsTools", {
                  turns: String(row.turns ?? 0),
                  tools: String(row.tools ?? 0),
                })}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

/**
 * Tool feed, plus the worker's output tail while it is still talking.
 *
 * `hideOutput` drops the tail once a real result exists: the tail is the last
 * lines of that same text, so keeping both would print the ending twice.
 */
function AsyncFeed({ step, hideOutput }: { step: AsyncRunStep; hideOutput: boolean }) {
  const t = useT();
  // newest first: the interesting end of a 25-entry feed is the bottom of the file
  const tools = [...step.recentTools].reverse();
  return (
    <>
      {tools.length > 0 && (
        <>
          <div style={SECTION_LABEL}>{t("subagents.recentTools")}</div>
          {tools.map((tool, i) => (
            <div
              key={`${tool.tool}-${tool.endMs ?? i}-${i}`}
              style={{ display: "flex", gap: 8, padding: "3px 0", minWidth: 0 }}
            >
              <span style={{ color: "var(--text-tertiary)", flexShrink: 0, lineHeight: "18px" }}>
                <Wrench size={11} />
              </span>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-primary)",
                  flexShrink: 0,
                }}
              >
                {tool.tool}
              </span>
              {tool.args && (
                <span
                  style={{
                    fontSize: 11.5,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-tertiary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: 0,
                  }}
                >
                  {tool.args}
                </span>
              )}
            </div>
          ))}
        </>
      )}

      {step.recentOutput.length > 0 && !hideOutput && (
        <>
          <div style={SECTION_LABEL}>{t("subagents.outputTail")}</div>
          <div
            style={{
              padding: "9px 11px",
              borderRadius: "var(--radius-md)",
              background: "var(--bg-base)",
              border: "1px solid var(--separator)",
              fontSize: 11.5,
              fontFamily: "var(--font-mono)",
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.55,
            }}
          >
            {step.recentOutput.join("\n")}
          </div>
        </>
      )}
    </>
  );
}

/** the synthesized timeline used by synchronous runs and the local demo */
function CardTimeline({ events, live }: { events: SubagentEvent[]; live: boolean }) {
  const t = useT();
  if (events.length === 0) {
    return live ? (
      <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", paddingTop: 14 }}>
        {t("subagents.working")}
      </div>
    ) : null;
  }
  return (
    <>
      <div style={SECTION_LABEL}>{t("subagents.timeline")}</div>
      {events.map((e, i) => (
        <motion.div
          key={e.id}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{
            type: "spring",
            stiffness: 400,
            damping: 30,
            delay: Math.min(i * 0.03, 0.3),
          }}
          style={{ display: "flex", gap: 12 }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              width: 16,
              flexShrink: 0,
            }}
          >
            <span
              style={{
                fontSize: 11,
                lineHeight: "20px",
                color:
                  e.kind === "text"
                    ? "var(--accent)"
                    : e.kind === "thinking"
                      ? "var(--agent-thinking)"
                      : "var(--text-tertiary)",
              }}
            >
              {KIND_ICON[e.kind]}
            </span>
            {i < events.length - 1 && (
              <div
                style={{ width: 1, flex: 1, minHeight: 8, background: "var(--separator)" }}
              />
            )}
          </div>
          <div style={{ paddingBottom: 14, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-primary)",
                fontFamily: e.kind === "tool" ? "var(--font-mono)" : "var(--font-ui)",
                fontStyle: e.kind === "thinking" ? "italic" : "normal",
              }}
            >
              {e.label}
            </div>
            {e.detail && (
              <div
                style={{
                  fontSize: 11.5,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-tertiary)",
                  marginTop: 2,
                  wordBreak: "break-word",
                }}
              >
                {e.detail}
              </div>
            )}
          </div>
        </motion.div>
      ))}
      {live && (
        <div style={{ fontSize: 11.5, color: "var(--text-tertiary)", paddingLeft: 28 }}>
          {t("subagents.working")}
        </div>
      )}
    </>
  );
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div
      style={{
        marginTop: 14,
        padding: "8px 10px",
        borderRadius: 8,
        background: "color-mix(in srgb, var(--danger) 12%, transparent)",
        border: "1px solid color-mix(in srgb, var(--danger) 45%, transparent)",
        fontSize: 11.5,
        fontFamily: "var(--font-mono)",
        color: "var(--text-primary)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {text}
    </div>
  );
}

/**
 * Files the run wrote — its report, saved output, child transcripts. Opening
 * one hands the absolute path to the workspace editor, which reads any path the
 * host can read, so an artifact outside the repo still opens.
 */
function Artifacts({ artifacts }: { artifacts: { label: string; path: string }[] }) {
  const t = useT();
  return (
    <>
      <div style={SECTION_LABEL}>{t("subagents.artifacts")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {artifacts.map((a) => (
          <button
            key={a.path}
            onClick={() => void useWorkspace.getState().openFile(a.path)}
            title={a.path}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              maxWidth: "100%",
              padding: "5px 9px",
              borderRadius: 999,
              background: "var(--bg-base)",
              border: "1px solid var(--separator)",
              color: "var(--text-secondary)",
              fontSize: 11.5,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
            }}
          >
            <FileText size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {a.label}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function Result({ text }: { text?: string }) {
  const t = useT();
  if (!text) return null;
  return (
    <>
      <div style={SECTION_LABEL}>{t("subagents.result")}</div>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "10px 11px",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-base)",
          border: "1px solid var(--separator)",
        }}
      >
        <span style={{ color: "var(--success)", flexShrink: 0, lineHeight: "18px" }}>
          <Check size={13} />
        </span>
        <div
          style={{
            fontSize: 12.5,
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.55,
            minWidth: 0,
          }}
        >
          {text}
        </div>
      </div>
    </>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Transcript row — a subagent's tool call in the conversation IS its control.

   No extra button stacked underneath: the row itself opens the inspector, shows
   what the worker is doing right now in the row's own detail slot, and takes an
   accent edge while its inspector is the open one. That edge is the continuity
   thread — you can always see which row the panel belongs to.
   ──────────────────────────────────────────────────────────────────────────── */

export interface SubagentRowState {
  /** open this subagent's inspector */
  open: () => void;
  /** its inspector is the one currently showing */
  active: boolean;
  /** live tool line for the row's detail slot, while running */
  detail?: string;
  /** elapsed time / outcome mark for the row's trailing slot */
  trailing: ReactNode;
  label: string;
}

/**
 * Live row state for one subagent tool call, or null when nothing is tracked
 * for it — a transcript restored from history has no snapshot, and a row that
 * cannot show progress must not pretend to be clickable.
 */
export function useSubagentRow(
  toolCallId: string,
  fallbackTitle: string
): SubagentRowState | null {
  const focusedId = useSubagents((s) => s.focusedId);
  const focus = useSubagents((s) => s.focus);
  // the array itself, filtered in render — a selector that builds a new array
  // compares unequal every time and would re-render this row on any store change
  const agents = useSubagents((s) => s.agents);
  const run = useSubagents((s) => s.asyncRuns[toolCallId]);
  const t = useT();

  const cards = agents.filter((a) => a.id.startsWith(`${toolCallId}#`));
  if (cards.length === 0 && !run) return null;

  const step = run?.steps[0];
  const status: SubagentStatus = cards[0] ? cards[0].status : asyncStateToStatus(run?.state);
  const live = status === "running";
  const inFlight = step?.currentTool
    ? { tool: step.currentTool, args: step.currentToolArgs }
    : step?.recentTools[step.recentTools.length - 1];
  const startedAt = step?.startedAt ?? cards[0]?.startedAt;
  const count = run?.steps.length ?? cards.length;

  const active = focusedId !== null && splitCardId(focusedId).toolCallId === toolCallId;

  return {
    // clicking the row that is already showing closes the panel, so the row is a
    // real toggle and Esc is a convenience rather than the only way out
    open: () => focus(active ? null : (cards[0]?.id ?? `${toolCallId}#0`)),
    active,
    ...(live && inFlight
      ? { detail: inFlight.args ? `${inFlight.tool} ${inFlight.args}` : inFlight.tool }
      : {}),
    trailing: live ? (
      startedAt !== undefined ? <Elapsed since={startedAt} /> : <PiSpark size={11} />
    ) : status === "error" ? (
      // stroke matched to the row's appica tool icon (1.75, not lucide's 2)
      <AlertTriangle size={11} strokeWidth={1.75} style={{ color: "var(--danger)" }} />
    ) : (
      <Check size={11} strokeWidth={1.75} style={{ color: "var(--success)" }} />
    ),
    label:
      count > 1
        ? t("subagents.rowLabelSteps", { title: fallbackTitle, n: String(count) })
        : fallbackTitle,
  };
}

