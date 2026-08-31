"use client";

import { useWorkspace } from "@/lib/workspace";
import { workspaceFsFor, type WorkspaceTargetId } from "@/lib/workspace-target";

/**
 * Live progress for *detached* subagent runs.
 *
 * `pi-subagents` (the installed producer) can run a subagent in the background:
 * the tool call returns immediately with `details.asyncDir` and an EMPTY
 * `results[]`, then the real worker keeps going in its own process for minutes.
 * Nothing about that progress comes back over the pi RPC stream — the
 * extension's `pi.events` bus is in-process only and cannot reach this app.
 *
 * What it does emit is a file. The runner rewrites
 * `<asyncDir>/status.json` every few seconds with the whole live picture, and
 * the extension's own docs point companion UIs at exactly these artifacts
 * rather than at scraped terminal output. So this module polls that file.
 *
 * Every field is feature-detected: the producer is a user-editable extension,
 * not protocol, and its docs require consumers to ignore unknown fields. A
 * half-written or unreadable file yields `null` (keep the last good snapshot)
 * instead of blanking the UI.
 */

/** one entry of `steps[].recentTools[]` — the "what is it doing right now" feed */
export interface AsyncRunTool {
  tool: string;
  args?: string;
  endMs?: number;
}

/** a file the run produced, surfaced as a link */
export interface AsyncRunArtifact {
  label: string;
  path: string;
}

/** one worker within the run (a workflow/chain step, or the single agent) */
export interface AsyncRunStep {
  agent: string;
  /** workflow node label ("main"), when the producer reports one */
  label?: string;
  status?: string;
  startedAt?: number;
  lastActivityAt?: number;
  durationMs?: number;
  model?: string;
  thinking?: string;
  turnCount?: number;
  toolCount?: number;
  recentTools: AsyncRunTool[];
  recentOutput: string[];
  /**
   * The tool running *right now*, when the producer reports one.
   *
   * `recentTools` only records calls that have already returned (each carries an
   * `endMs`), so during a slow call its last entry is the *previous* tool. This
   * is what makes the difference between "it just read a file" and "it has been
   * running a grep for 40 seconds".
   */
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartedAt?: number;
  /** per-worker task text, when reported (the async status file redacts it) */
  task?: string;
  /** per-worker failure detail */
  error?: string;
}

/** one `status.json` read, normalized */
export interface AsyncRunStatus {
  runId?: string;
  /** join key back to the tool call in the transcript */
  toolCallId?: string;
  mode?: string;
  /** producer's lifecycle state: running / complete / failed / stopped / paused… */
  state?: string;
  startedAt?: number;
  lastUpdate?: number;
  endedAt?: number;
  cwd?: string;
  steps: AsyncRunStep[];
  tokens?: { input: number; output: number; total: number };
  costUsd?: number;
  turnCount?: number;
  toolCount?: number;
  /** final text of the run, once the producer has written one */
  finalOutput?: string;
  /** failure detail, when a worker reported one */
  errorText?: string;
  artifacts: AsyncRunArtifact[];
  /** true once the run can no longer change — stop polling */
  terminal: boolean;
}

/* ── defensive readers: everything here comes off disk, shape unguaranteed ── */

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = str(item);
    if (s !== undefined) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/* ── terminal detection ──
   `state` is the producer's own vocabulary and it may add values, so an
   unrecognized state is treated as still-running (keep polling) unless the run
   has an `endedAt` — which only gets written once, at the end. */

const TERMINAL_STATES = new Set(["complete", "completed", "failed", "error", "stopped", "cancelled", "canceled", "timeout"]);

function isTerminal(state: string | undefined, endedAt: number | undefined): boolean {
  if (endedAt !== undefined) return true;
  return state !== undefined && TERMINAL_STATES.has(state.toLowerCase());
}

/** map the producer's step/run state onto the card's four-state vocabulary */
export function asyncStateToStatus(state: string | undefined): "queued" | "running" | "done" | "error" {
  const s = (state ?? "").toLowerCase();
  if (s === "complete" || s === "completed" || s === "success") return "done";
  if (s === "failed" || s === "error" || s === "stopped" || s === "cancelled" || s === "canceled" || s === "timeout") return "error";
  if (s === "pending" || s === "queued" || s === "waiting") return "queued";
  return "running";
}

/* ── parsing ── */

/** cap the live feeds so one long-running worker cannot grow the store forever */
const MAX_TOOLS = 40;
const MAX_OUTPUT = 24;
const MAX_ARTIFACTS = 12;

function readTools(v: unknown): AsyncRunTool[] {
  if (!Array.isArray(v)) return [];
  const out: AsyncRunTool[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    const tool = str(rec?.tool);
    if (!tool) continue;
    out.push({
      tool,
      ...(str(rec?.args) ? { args: str(rec?.args) } : {}),
      ...(num(rec?.endMs) !== undefined ? { endMs: num(rec?.endMs) } : {}),
    });
    if (out.length >= MAX_TOOLS) break;
  }
  return out;
}

function readSteps(v: unknown): AsyncRunStep[] {
  if (!Array.isArray(v)) return [];
  const out: AsyncRunStep[] = [];
  for (const item of v) {
    const rec = asRecord(item);
    if (!rec) continue;
    out.push({
      agent: str(rec.agent) ?? "subagent",
      ...(str(rec.label) ? { label: str(rec.label) } : {}),
      ...(str(rec.status) ? { status: str(rec.status) } : {}),
      ...(num(rec.startedAt) !== undefined ? { startedAt: num(rec.startedAt) } : {}),
      ...(num(rec.lastActivityAt) !== undefined ? { lastActivityAt: num(rec.lastActivityAt) } : {}),
      ...(num(rec.durationMs) !== undefined ? { durationMs: num(rec.durationMs) } : {}),
      ...(str(rec.model) ? { model: str(rec.model) } : {}),
      ...(str(rec.thinking) ? { thinking: str(rec.thinking) } : {}),
      ...(num(rec.turnCount) !== undefined ? { turnCount: num(rec.turnCount) } : {}),
      ...(num(rec.toolCount) !== undefined ? { toolCount: num(rec.toolCount) } : {}),
      recentTools: readTools(rec.recentTools),
      recentOutput: strList(rec.recentOutput, MAX_OUTPUT),
      ...(str(rec.currentTool) ? { currentTool: str(rec.currentTool) } : {}),
      ...(str(rec.currentToolArgs) ? { currentToolArgs: str(rec.currentToolArgs) } : {}),
      ...(num(rec.currentToolStartedAt) !== undefined
        ? { currentToolStartedAt: num(rec.currentToolStartedAt) }
        : {}),
      ...(str(rec.task) ? { task: str(rec.task) } : {}),
      ...(str(rec.error) ? { error: str(rec.error) } : {}),
    });
  }
  return out;
}

/**
 * The per-worker result list. Workflow mode nests it under `workflow.value`;
 * single and chain modes keep it at the top level. Checked in that order
 * because an async workflow's top-level `results` stays the empty array the
 * tool call returned.
 */
function readResults(root: Record<string, unknown>): Record<string, unknown>[] {
  const nested = asRecord(asRecord(root.workflow)?.value)?.results;
  const flat = root.results;
  const list = Array.isArray(nested) && nested.length > 0 ? nested : Array.isArray(flat) ? flat : [];
  return list.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
}

/** basename of a Windows or POSIX path, for the artifact link label */
function baseName(p: string): string {
  const cut = p.lastIndexOf("/") >= 0 || p.lastIndexOf("\\") >= 0
    ? Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1
    : 0;
  return p.slice(cut) || p;
}

/**
 * Every file the run points at, deduped by path. Sources differ per mode and
 * per producer version, so each is probed independently rather than assuming
 * one canonical field.
 */
function readArtifacts(root: Record<string, unknown>, results: Record<string, unknown>[]): AsyncRunArtifact[] {
  const seen = new Set<string>();
  const out: AsyncRunArtifact[] = [];
  const push = (raw: unknown) => {
    const p = str(raw);
    if (!p || seen.has(p) || out.length >= MAX_ARTIFACTS) return;
    seen.add(p);
    out.push({ label: baseName(p), path: p });
  };

  for (const p of strList(asRecord(asRecord(root.workflow)?.value)?.artifactPaths, MAX_ARTIFACTS)) push(p);

  for (const r of results) {
    push(r.savedOutputPath);
    push(asRecord(r.outputReference)?.path);
    // `artifactPaths` is an object of named paths per result, but older
    // producers wrote a plain list — accept both.
    const paths = r.artifactPaths;
    if (Array.isArray(paths)) for (const p of strList(paths, MAX_ARTIFACTS)) push(p);
    else {
      const rec = asRecord(paths);
      if (rec) for (const value of Object.values(rec)) push(value);
    }
    push(r.transcriptPath);
  }
  return out;
}

/**
 * Why a run failed. Same field family the synchronous path reads, because the
 * same producer writes both — but only trusted when the run actually failed, so
 * a stale `stderr` on a successful run is not reported as an error.
 */
function readErrorText(results: Record<string, unknown>[]): string | undefined {
  for (const r of results) {
    const exitCode = num(r.exitCode);
    const stopReason = str(r.stopReason);
    const failed =
      (exitCode !== undefined && exitCode > 0) ||
      stopReason === "error" ||
      stopReason === "aborted";
    if (!failed) continue;
    const text =
      str(r.errorMessage) ??
      str(r.stderr) ??
      (stopReason ? `stopped: ${stopReason}` : undefined);
    if (text) return text.slice(0, 2000);
  }
  return undefined;
}

/**
 * The run's answer: first result that actually carries output text.
 *
 * Bounded, because this snapshot is held in memory for the whole session and a
 * worker's final report runs to tens of KB. The full text stays one click away
 * through the artifact links.
 */
const MAX_FINAL_OUTPUT = 4000;

function readFinalOutput(results: Record<string, unknown>[]): string | undefined {
  for (const r of results) {
    const text = str(r.finalOutput) ?? str(r.output);
    if (text) return text.slice(0, MAX_FINAL_OUTPUT);
  }
  return undefined;
}

/** `status.json` text → normalized snapshot, or null if it is not usable yet */
export function parseAsyncStatus(raw: string): AsyncRunStatus | null {
  if (!raw.trim()) return null; // mock fs returns "" for unknown paths
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // torn read: the runner rewrites this file while we poll it
  }
  const root = asRecord(parsed);
  if (!root) return null;

  const results = readResults(root);
  const state = str(root.state);
  const endedAt = num(root.endedAt);
  const tokens = asRecord(root.totalTokens);
  const cost = asRecord(root.totalCost);
  const finalOutput = readFinalOutput(results);
  const errorText = readErrorText(results);

  return {
    ...(str(root.runId) ? { runId: str(root.runId) } : {}),
    ...(str(root.toolCallId) ? { toolCallId: str(root.toolCallId) } : {}),
    ...(str(root.mode) ? { mode: str(root.mode) } : {}),
    ...(state ? { state } : {}),
    ...(num(root.startedAt) !== undefined ? { startedAt: num(root.startedAt) } : {}),
    ...(num(root.lastUpdate) !== undefined ? { lastUpdate: num(root.lastUpdate) } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(str(root.cwd) ? { cwd: str(root.cwd) } : {}),
    steps: readSteps(root.steps),
    ...(tokens
      ? {
          tokens: {
            input: num(tokens.input) ?? 0,
            output: num(tokens.output) ?? 0,
            total: num(tokens.total) ?? (num(tokens.input) ?? 0) + (num(tokens.output) ?? 0),
          },
        }
      : {}),
    ...(num(cost?.costUsd) !== undefined ? { costUsd: num(cost?.costUsd) } : {}),
    ...(num(root.turnCount) !== undefined ? { turnCount: num(root.turnCount) } : {}),
    ...(num(root.toolCount) !== undefined ? { toolCount: num(root.toolCount) } : {}),
    ...(finalOutput ? { finalOutput } : {}),
    ...(errorText ? { errorText } : {}),
    artifacts: readArtifacts(root, results),
    terminal: isTerminal(state, endedAt),
  };
}

/* ── the synchronous stream ── */

/**
 * The parts of a foreground tool payload that describe the *outcome* rather than
 * the progress: what the workers produced and where they wrote it.
 *
 * Split out because the two arrive on different events. `progress[]` streams
 * during the run, while the final result is the only payload that carries the
 * saved output paths and transcripts — so the closing update has to merge these
 * into the snapshot the streaming updates built.
 */
export function readSyncOutcome(payload: unknown): {
  finalOutput?: string;
  errorText?: string;
  artifacts: AsyncRunArtifact[];
} {
  const details = asRecord(asRecord(payload)?.details);
  if (!details) return { artifacts: [] };
  const results = readResults(details);
  const finalOutput = readFinalOutput(results);
  const errorText = readErrorText(results);
  return {
    ...(finalOutput ? { finalOutput } : {}),
    ...(errorText ? { errorText } : {}),
    artifacts: readArtifacts(details, results),
  };
}

/**
 * A *foreground* subagent's live progress, off `tool_execution_update`.
 *
 * `pi-subagents` streams `details.progress[]` (its `AgentProgress`) on every
 * step of a foreground run — current tool, recent tools, output tail, counts.
 * Its `recentTools` / `recentOutput` are the same shape the async status file
 * writes, so a foreground run maps onto exactly the model the panel already
 * renders. Same surface, two transports: nothing about the UI has to know which
 * kind of run it is looking at.
 *
 * Without this the panel had only `results[].toolCalls` to work with — a bounded
 * tail of pre-rendered strings that says nothing about what is running *now*,
 * which is why a foreground run read as one lump arriving at the end.
 */
export function readSyncProgress(payload: unknown): AsyncRunStatus | null {
  const details = asRecord(asRecord(payload)?.details);
  if (!details) return null;
  const list = details.progress;
  if (!Array.isArray(list) || list.length === 0) return null;

  const steps: AsyncRunStep[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    steps.push({
      agent: str(rec.agent) ?? "subagent",
      ...(str(rec.status) ? { status: str(rec.status) } : {}),
      ...(num(rec.lastActivityAt) !== undefined
        ? { lastActivityAt: num(rec.lastActivityAt) }
        : {}),
      ...(num(rec.durationMs) !== undefined ? { durationMs: num(rec.durationMs) } : {}),
      ...(str(rec.model) ? { model: str(rec.model) } : {}),
      ...(str(rec.thinking) ? { thinking: str(rec.thinking) } : {}),
      ...(num(rec.turnCount) !== undefined ? { turnCount: num(rec.turnCount) } : {}),
      ...(num(rec.toolCount) !== undefined ? { toolCount: num(rec.toolCount) } : {}),
      recentTools: readTools(rec.recentTools),
      recentOutput: strList(rec.recentOutput, MAX_OUTPUT),
      ...(str(rec.currentTool) ? { currentTool: str(rec.currentTool) } : {}),
      ...(str(rec.currentToolArgs) ? { currentToolArgs: str(rec.currentToolArgs) } : {}),
      ...(num(rec.currentToolStartedAt) !== undefined
        ? { currentToolStartedAt: num(rec.currentToolStartedAt) }
        : {}),
      ...(str(rec.task) ? { task: str(rec.task) } : {}),
      ...(str(rec.error) ? { error: str(rec.error) } : {}),
    });
  }
  if (steps.length === 0) return null;

  // `tokens` on a progress entry is the running total for that worker
  const totals = list.reduce(
    (acc, item) => {
      const rec = asRecord(item);
      return {
        input: acc.input + (num(rec?.inputTokens) ?? 0),
        output: acc.output + (num(rec?.outputTokens) ?? 0),
        total: acc.total + (num(rec?.tokens) ?? 0),
      };
    },
    { input: 0, output: 0, total: 0 }
  );

  // A foreground run is over when its tool call ends, not on a state string —
  // the caller knows that, so this never claims to be terminal itself.
  return {
    ...(str(details.runId) ? { runId: str(details.runId) } : {}),
    ...(str(details.mode) ? { mode: str(details.mode) } : {}),
    steps,
    ...(totals.total > 0 || totals.input > 0 ? { tokens: totals } : {}),
    ...readSyncOutcome(payload),
    terminal: false,
  };
}

/* ── polling ── */

/** joined with a separator the host understands; asyncDir is absolute + native */
export function statusPathOf(asyncDir: string): string {
  const sep = asyncDir.includes("\\") && !asyncDir.includes("/") ? "\\" : "/";
  return `${asyncDir.replace(/[/\\]+$/, "")}${sep}status.json`;
}

/**
 * Read one snapshot. Resolves null on any read/parse failure — never throws.
 *
 * `asyncDir` is produced by a pi tool call, so it belongs to whichever host pi
 * runs on: for a remote target it is a remote path, and reading it through the
 * local filesystem was always wrong. It resolves against the active workspace
 * target by default, which is correct whenever the polled run belongs to the
 * conversation on screen. A caller that knows otherwise — a background task on
 * another target — should pass `targetId` explicitly.
 */
export async function readAsyncStatus(
  asyncDir: string,
  targetId: WorkspaceTargetId = useWorkspace.getState().targetId,
): Promise<AsyncRunStatus | null> {
  try {
    const raw = await workspaceFsFor(targetId).readFile(statusPathOf(asyncDir));
    return parseAsyncStatus(raw);
  } catch {
    // not written yet, over the host's read cap, no fs bridge in this build, or
    // the target has no remote filesystem access yet
    return null;
  }
}

/** while the app is hidden the drawer cannot be read — back off instead of stopping */
const POLL_ACTIVE_MS = 1500;
const POLL_HIDDEN_MS = 6000;

function pollDelay(): number {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  return hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS;
}

/**
 * Give up on a run whose `status.json` has stopped advancing.
 *
 * A live runner rewrites the file continuously, so this only trips when the
 * worker is gone without having written a terminal state — otherwise the poll
 * would run for the rest of the session. It deliberately does NOT conclude the
 * run failed: the producer's docs are explicit that process exit must not be
 * inferred from missing artifacts, so the last snapshot simply stands and the
 * UI reports how stale it is.
 *
 * Well past any normal write cadence, and past the producer's own 30-minute
 * default wall-clock timeout only in the sense that a timing-out run still
 * writes while it waits.
 */
const MAX_STALE_MS = 15 * 60 * 1000;

/**
 * Poll one run's `status.json` until it goes terminal, then stop.
 *
 * Self-scheduling rather than `setInterval`: a slow read must not stack up
 * overlapping polls. Returns a canceller; calling it prevents any further
 * `onSnapshot`.
 */
export function pollAsyncRun(
  asyncDir: string,
  onSnapshot: (status: AsyncRunStatus) => void
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** last `lastUpdate` we saw, and when we first saw it — drives the stale cutoff */
  let seenUpdate: number | undefined;
  let seenAt = Date.now();

  const tick = async () => {
    if (cancelled) return;
    const status = await readAsyncStatus(asyncDir);
    if (cancelled) return;
    if (status) {
      onSnapshot(status);
      // one last snapshot has been delivered — nothing more will change
      if (status.terminal) return;

      const now = Date.now();
      if (status.lastUpdate !== seenUpdate) {
        seenUpdate = status.lastUpdate;
        seenAt = now;
      } else if (now - seenAt > MAX_STALE_MS) {
        return; // the runner has stopped writing; keep the snapshot, stop asking
      }
    }
    timer = setTimeout(tick, pollDelay());
  };

  void tick();

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

