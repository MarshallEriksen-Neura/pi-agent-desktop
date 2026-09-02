"use client";

import { create } from "zustand";
import { getChatStore, clearChatStores, type ChatMessage } from "./chat";
import { getPiStore, clearPiStores } from "./store";
import { getPiClient, disposeAllPiClients, disposePiClient } from "./client";
import { prepareRemoteBinding } from "./remote-task-binding";
import { sessionEntriesToChatMessages, type PiEntriesSnapshot } from "./session-transcript";
import { foldPlan, usePlan } from "./plan";
import { useExtUi } from "./ext-ui";
import { t } from "../i18n";
import type { GenerateTitleInput, SessionRepositoryPort, SessionScope } from "../backend/ports";
import type { ExecutionBinding } from "../backend/ports/execution-target";
import { getBackendKind, getPort } from "../backend/composition/container";
import {
  readCurrentPiSessionPath,
  getCurrentPiModel,
  syncPiSessionName,
} from "../orchestration/session-lifecycle";
import { setActiveTaskId, getActiveTaskId, setSessionTitle, setFocusSessionHandler } from "./task-context";
import { DEFAULT_TASK_ID } from "../backend/ports/pi-process";
import { workspaceTargetIdFor, type WorkspaceTargetId } from "../workspace-target";
const LOCAL_EXECUTION_BINDING: ExecutionBinding = { kind: "local", targetId: "local" };

/**
 * Chat-session history — zustand in front, SQLite (Tauri/Rust) behind.
 * In the browser preview (mock transport) it falls back to localStorage so a
 * refresh still restores the conversation.
 *
 * Each record stores the desktop-side transcript (messages JSON) plus pi's
 * `sessionPath`, so switching a session both repaints the UI instantly and
 * points the pi process back at the matching session file.
 *
 * History is scoped per project root: the sidebar only ever lists conversations
 * belonging to the open project, and switching projects swaps the whole list.
 * Cross-project sessions must stay invisible — resuming one would point pi at a
 * session file recorded under a different cwd.
 *
 * Parallel tasks: every session owns its own pi process (keyed by the session
 * id via `task-context`), so switching conversations no longer restarts or
 * kills a running task — background tasks keep streaming into their own stores.
 */

export interface ChatSessionMeta {
  id: string;
  name: string;
  sessionPath: string;
  preview: string;
  /** Canonical project root this conversation belongs to ("" in browser preview). */
  projectRoot: string;
  /** Target identity is persisted with the transcript; old rows default to local. */
  executionBinding?: ExecutionBinding;
  /** Stable Pi authority identity; null until Pi materializes a new session. */
  authoritySessionId?: string | null;
  source?: "cache" | "native";
  createdAt: number;
  updatedAt: number;
}

interface SessionsStore {
  sessions: ChatSessionMeta[];
  activeId: string | null;
  initialized: boolean;
  /** Project root the current list is scoped to. */
  projectRoot: string;
  /** Currently selected target for newly created conversations. */
  executionBinding: ExecutionBinding;
  setExecutionBinding: (binding: ExecutionBinding) => void;
  switchExecutionTarget: (binding: ExecutionBinding, localProjectRoot: string) => Promise<void>;

  init: (projectRoot: string) => Promise<void>;
  /** Re-scope history to another project (called after the workspace switches). */
  switchProject: (projectRoot: string) => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (id: string) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

export function executionTargetKey(binding: ExecutionBinding): string {
  return binding.kind === "ssh" ? `ssh:${binding.profileId}` : "local";
}

function sessionScope(meta: Pick<ChatSessionMeta, "projectRoot" | "executionBinding">): SessionScope {
  return {
    targetKey: executionTargetKey(meta.executionBinding ?? LOCAL_EXECUTION_BINDING),
    projectRoot: projectKey(meta.projectRoot),
  };
}

export function executionScopeKey(binding: ExecutionBinding, localProjectRoot: string): string {
  if (binding.kind === "local") return projectKey(localProjectRoot);
  return `ssh:${encodeURIComponent(binding.profileId)}:${encodeURIComponent(binding.remoteCwd)}`;
}

function sameExecutionScope(
  left: ExecutionBinding | undefined,
  right: ExecutionBinding
): boolean {
  const current = left ?? LOCAL_EXECUTION_BINDING;
  if (current.kind !== right.kind) return false;
  if (current.kind === "local") return right.kind === "local";
  return (
    right.kind === "ssh" &&
    current.profileId === right.profileId &&
    current.profileRevision === right.profileRevision &&
    current.hostAlias === right.hostAlias &&
    current.remoteCwd === right.remoteCwd &&
    current.launcherProtocolVersion === right.launcherProtocolVersion
  );
}

function sameExecutionBinding(
  left: ExecutionBinding | undefined,
  right: ExecutionBinding
): boolean {
  if (!sameExecutionScope(left, right)) return false;
  const current = left ?? LOCAL_EXECUTION_BINDING;
  if (current.kind === "local") return true;
  return (
    right.kind === "ssh" &&
    (current.remoteTaskId ?? null) === (right.remoteTaskId ?? null) &&
    (current.remoteTaskPending ?? false) === (right.remoteTaskPending ?? false)
  );
}

function cwdForBinding(
  binding: ExecutionBinding | undefined,
  localProjectRoot: string,
 ): string | undefined {
  return binding?.kind === "ssh" ? binding.remoteCwd : localProjectRoot || undefined;
}


/**
 * Canonical project key — forward slashes, no trailing slash. Mirrors
 * `projects::project_key` in Rust so both sides agree on what "same project" is.
 */
export function projectKey(root: string | null | undefined): string {
  return (root ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/* ── persistence backend: injected Tauri SQLite repository, or browser mock ── */

interface SessionDependencies {
  repository: SessionRepositoryPort;
  desktopFeatures: boolean;
  projectRoot: () => string | null;
}

let configuredDependencies: SessionDependencies | null = null;

function defaultDependencies(): SessionDependencies {
  return {
    repository: getPort("sessionRepository"),
    desktopFeatures: getBackendKind() === "desktop-tauri",
    projectRoot: () => useSessions.getState().projectRoot,
  };
}

function sessionDependencies(): SessionDependencies {
  return configuredDependencies ?? defaultDependencies();
}

export function configureSessionDependenciesForTests(
  dependencies: SessionDependencies | null
): void {
  configuredDependencies = dependencies;
}

export function configureSessionProjectRootResolver(
  projectRoot: () => string | null,
): void {
  configuredDependencies = {
    repository: getPort("sessionRepository"),
    desktopFeatures: getBackendKind() === "desktop-tauri",
    projectRoot,
  };
}

/**
 * Notified when the execution target changes, so the workspace can repoint.
 *
 * A seam rather than a direct call because `workspace.ts` already depends on this
 * module and importing it back would cycle. Same shape as
 * `configureChatRecovery`: registered once from `AppShell`, and a no-op until it
 * is, so tests and the preview do not need it.
 */
let targetSwitchListener: ((targetId: WorkspaceTargetId) => void) | null = null;

export function configureWorkspaceTargetSwitch(
  listener: (targetId: WorkspaceTargetId) => void,
): void {
  targetSwitchListener = listener;
}

export function resetWorkspaceTargetSwitchForTests(): void {
  targetSwitchListener = null;
}

/**
 * Announce the target a conversation now runs on.
 *
 * Called after the new binding is committed, never before: the workspace clears
 * tree and document state, so doing it early would blank the UI while a switch
 * could still fail and leave the old binding in place.
 */
function announceExecutionTarget(binding: ExecutionBinding): void {
  targetSwitchListener?.(workspaceTargetIdFor(binding));
}

async function backendList(
  projectRoot: string,
  binding: ExecutionBinding = LOCAL_EXECUTION_BINDING
): Promise<ChatSessionMeta[]> {
  const scope = { targetKey: executionTargetKey(binding), projectRoot: projectKey(projectRoot) };
  return sessionDependencies().repository.list(scope);
}

/**
 * Read only the newest session's `sessionPath` for `projectRoot`, without
 * touching the store — used at app launch and on project switch (before
 * `connect`/`restart`) so pi can be spawned with `--session <path>` and resume
 * the full prior context in-process, instead of starting blank and trying to
 * catch up via a post-start `switch_session` RPC.
 * Returns "" when the project has no prior session, the newest one has no
 * pinned path yet, or in browser preview.
 */
export async function peekLatestSessionPath(projectRoot: string): Promise<string> {
  const list = await backendList(projectRoot);
  return list[0]?.sessionPath?.trim() ?? "";
}

async function backendLoad(meta: ChatSessionMeta): Promise<ChatMessage[]> {
  return sessionDependencies().repository.load(sessionScope(meta), meta.id);
}

async function backendSave(meta: ChatSessionMeta, messages: ChatMessage[]) {
  await sessionDependencies().repository.save(sessionScope(meta), {
    ...meta,
    projectRoot: projectKey(meta.projectRoot),
    messages,
  });
}

async function backendRename(meta: ChatSessionMeta, name: string) {
  await sessionDependencies().repository.rename(sessionScope(meta), meta.id, name);
}

async function backendDelete(meta: ChatSessionMeta) {
  await sessionDependencies().repository.delete(sessionScope(meta), meta.id);
}

async function backendTrashSessionFile(meta: ChatSessionMeta, path: string) {
  await sessionDependencies().repository.trashSessionFile(sessionScope(meta), path);
}

/**
 * The transcript a delete should move to the trash, or null to leave disk alone.
 *
 * Two conversations are deliberately excluded. One with no pinned `sessionPath`
 * never had a transcript to begin with (pi does not materialize the file until
 * the first turn), and an SSH conversation's transcript lives on the remote
 * host — the launcher has no file operations, so reaching it would need a new
 * launcher mode and a protocol bump. Both are skips, not failures: the row still
 * goes, and the remote file stays where the remote pi can still resume it.
 */
export function trashableTranscript(meta: ChatSessionMeta | undefined): string | null {
  if (!meta) return null;
  if ((meta.executionBinding?.kind ?? "local") !== "local") return null;
  const path = meta.sessionPath.trim();
  return path ? path : null;
}

/* ── helpers ── */

const nowId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function createMeta(
  projectRoot: string,
  executionBinding: ExecutionBinding = LOCAL_EXECUTION_BINDING,
 ): ChatSessionMeta {
  const now = Date.now();
  return {
    id: nowId(),
    name: "",
    sessionPath: "",
    preview: "",
    projectRoot: projectKey(projectRoot),
    executionBinding,
    createdAt: now,
    updatedAt: now,
  };
}

function deriveName(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.text.trim());
  return first ? first.text.trim().slice(0, 40) : "";
}

function derivePreview(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.text.trim());
  return last ? last.text.trim().slice(0, 80) : "";
}

/* ── per-task runtime bookkeeping ── */

/** Tasks whose pi process has been started — their store holds live state. */
const liveTasks = new Set<string>();
/** Tasks whose chat store has an autosave subscription attached. */
const autosaved = new Set<string>();
/** Tasks currently repainting from the DB — autosave must not fire during load. */
const restoringTasks = new Set<string>();
/** Tasks whose `session` listener is registered for sessionPath re-sync. */
const syncListenerHooked = new Set<string>();
/** Tasks that pinned pi's sessionPath at least once (gates the warning toast). */
const sessionPathSynced = new Set<string>();
/** Tasks with a syncSessionPath call in flight — prevents stacked retry loops. */
const sessionPathSyncing = new Set<string>();
/** Tasks warned about a missing sessionPath (avoid spam). */
const sessionPathWarningFor = new Set<string>();
/** Debounced save timers, one per task. */
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Invalidates late native transcript responses after navigation/reset. */
let hydrationEpoch = 0;
/** One in-flight title request per conversation. */
const titleRequests = new Map<string, string>();
/** Failed requests keep the normal fallback; streaming updates must not retry them. */
const titleAttempts = new Set<string>();

/**
 * Retry delays for syncSessionPath when pi isn't ready to answer get_state yet
 * (session resume and extension load can both delay readiness). The initial call in
 * init()/switchProject()/startFresh() may hit this window.
 */
const SYNC_DELAYS_MS = [2_000, 5_000, 10_000];

/**
 * Persist a binding the remote lifecycle changed — a minted or replaced `remoteTaskId`.
 *
 * It has to survive a restart: reattaching means presenting the *same* id, and a lost one
 * would start a second pi over the same session file, which is the V1 defect the one-id
 * rule exists to prevent. No schema change is needed because the binding is already part
 * of the session record.
 */
async function persistExecutionBinding(taskId: string, binding: ExecutionBinding): Promise<void> {
  let updated: ChatSessionMeta | undefined;
  useSessions.setState((state) => ({
    sessions: state.sessions.map((session) => {
      if (session.id !== taskId || sameExecutionBinding(session.executionBinding, binding)) {
        return session;
      }
      updated = { ...session, executionBinding: binding, updatedAt: Date.now() };
      return updated;
    }),
  }));
  if (!updated) {
    const current = useSessions.getState().sessions.find((session) => session.id === taskId);
    if (!current) {
      throw new Error(`cannot persist execution binding for unknown session ${taskId}`);
    }
    return;
  }
  // This write is a detached-task protocol boundary, not a debounced UI save.
  await backendSave(updated, getChatStore(taskId).getState().messages);
}

/**
 * The cursor a reattach should resume from.
 *
 * Read off the live process port rather than stored separately: it is the only thing that
 * knows which sequences actually reached the chat pipeline. `undefined` means no attach
 * has run yet, so replay starts from the oldest retained record.
 */
function appliedSequenceFor(taskId: string): number | undefined {
  const port = getPiClient(taskId).process;
  const applied = (port as { appliedSequence?: number | null } | undefined)?.appliedSequence;
  return typeof applied === "number" && applied > 0 ? applied : undefined;
}

/** Persist a task's session with the current chat transcript right now. */
async function flushSave(taskId?: string) {
  const id = taskId ?? useSessions.getState().activeId;
  if (!id) return;
  const timer = saveTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    saveTimers.delete(id);
  }
  const current = useSessions.getState().sessions.find((s) => s.id === id);
  if (!current) return;
  const messages = getChatStore(id).getState().messages;
  const meta: ChatSessionMeta = {
    ...current,
    name: current.name || deriveName(messages),
    preview: derivePreview(messages),
    updatedAt: Date.now(),
  };
  useSessions.setState((s) => ({
    sessions: s.sessions
      .map((x) => (x.id === meta.id ? meta : x))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }));
  try {
    await backendSave(meta, messages);
  } catch {
    // persistence failure must never break the conversation flow
  }
}

function scheduleSave(taskId: string) {
  const timer = saveTimers.get(taskId);
  if (timer) clearTimeout(timer);
  saveTimers.set(
    taskId,
    setTimeout(() => {
      saveTimers.delete(taskId);
      void flushSave(taskId);
    }, 800)
  );
}

/**
 * Generate the initial display name outside the primary Pi conversation.
 *
 * The request is deliberately best effort: a failed or stale result leaves the
 * existing first-message fallback intact and must never affect a user prompt.
 */
async function generateInitialTitle(taskId: string, messages: ChatMessage[]) {
  const dependencies = sessionDependencies();
  if (!dependencies.desktopFeatures) return;
  const { activeId, sessions } = useSessions.getState();
  if (!activeId || titleAttempts.has(taskId)) return;
  const session = sessions.find((item) => item.id === taskId);
  if (!session) return;
  // V1 does not start a second local Pi process for remote conversations.
  if (session.executionBinding?.kind === "ssh") return;

  const userMessages = messages.filter((message) => message.role === "user" && message.text.trim());
  if (userMessages.length !== 1) return;
  const firstMessage = userMessages[0];
  titleAttempts.add(taskId);
  titleRequests.set(taskId, firstMessage.id);

  try {
    const model = getCurrentPiModel(taskId);
    const input: GenerateTitleInput = {
      prompt: firstMessage.text,
      provider: model?.provider ?? null,
      modelId: model?.id ?? null,
      cwd: dependencies.projectRoot(),
    };
    const title = await dependencies.repository.generateTitle(input);
    const normalized = title.trim();
    if (!normalized) return;

    const current = useSessions.getState();
    const target = current.sessions.find((item) => item.id === taskId);
    // A late title must never rename another conversation or replace a name
    // the user entered while the model request was running.
    if (current.activeId !== taskId || !target || titleRequests.get(taskId) !== firstMessage.id) return;
    const fallback = deriveName(messages);
    if (target.name && target.name !== fallback) return;
    await current.renameSession(taskId, normalized);
  } catch {
    // Title generation is optional; the normal first-message fallback remains.
  } finally {
    if (titleRequests.get(taskId) === firstMessage.id) titleRequests.delete(taskId);
  }
}

/**
 * Persist a session right now. Exported for callers that are about to tear down
 * the pi process / swap projects and must not lose the transcript.
 */
export function flushActiveSession(): Promise<void> {
  return flushSave();
}

/**
 * Ask pi for its current session file path for a task and pin it on the record.
 *
 * Without one of these, sessionPath stays empty in SQLite and the next app
 * launch spawns pi without `--session` — the agent loses all prior context
 * while the UI still shows history (the "AI forgot" symptom).
 *
 * This must run again every time pi announces a session, not just once per task:
 * pi moves to a **new session file** whenever it starts without `--session`, and
 * on `fork`/`clone`. A pin that never follows leaves SQLite pointing at a file
 * pi no longer writes to, and the next launch resumes that stale file. Worse,
 * pi's `--session <path>` creates a fresh session *at that path* when the file
 * is missing or empty — truncating it — so a stale pin can also destroy a
 * transcript. Re-pinning on every announcement is what keeps the row honest.
 */
async function syncSessionPath(taskId: string): Promise<void> {
  if (!sessionDependencies().desktopFeatures) return;
  // Retries sleep for seconds; a second caller arriving meanwhile (connect +
  // `session` event both fire) must not start a competing loop.
  if (sessionPathSyncing.has(taskId)) return;
  sessionPathSyncing.add(taskId);
  try {
    let lastFailure = "";
    for (let attempt = 0; attempt <= SYNC_DELAYS_MS.length; attempt++) {
      const result = await readCurrentPiSessionPath(taskId);
      const path = result.path;
      const authoritySessionId = result.authoritySessionId;
      lastFailure = result.failure;

      if (path && useSessions.getState().activeId) {
        sessionPathSynced.add(taskId);
        sessionPathWarningFor.delete(taskId);
        const current = useSessions
          .getState()
          .sessions.find((x) => x.id === taskId);
        // Unchanged is the common case (a plain resume reuses the same file) —
        // skip the write rather than churning SQLite on every announcement.
        if (
          !current ||
          (current.sessionPath === path && current.authoritySessionId === authoritySessionId)
        ) return;
        useSessions.setState((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === taskId
              ? { ...x, sessionPath: path, authoritySessionId, source: "native" }
              : x
          ),
        }));
        const meta = useSessions
          .getState()
          .sessions.find((x) => x.id === taskId);
        if (meta) await backendSave(meta, getChatStore(taskId).getState().messages);
        return; // success
      }
      // Nothing yet — pi may still be booting. Retry.
      if (attempt < SYNC_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, SYNC_DELAYS_MS[attempt]));
      } else {
        console.warn(
          "[syncSessionPath] failed after retries — no sessionFile/sessionId from get_state. " +
            `Next launch will start pi without --session.${lastFailure ? ` ${lastFailure}` : ""}`,
        );
        if (!sessionPathSynced.has(taskId) && !sessionPathWarningFor.has(taskId)) {
          sessionPathWarningFor.add(taskId);
          useExtUi.getState().pushToast(t("session.noPath"), "warning", 8000);
        }
      }
    }
  } finally {
    sessionPathSyncing.delete(taskId);
  }
}

/**
 * Rebuild a task's folded plan from a restored transcript.
 *
 * The live plan is folded from `todo` calls as they stream in (agent-bridge), so a
 * session restored from history would otherwise show no plan at all — the calls
 * that built it are in the transcript, but they already happened. Replaying them
 * is the same fold, run over the whole branch at once; `args` survive the round
 * trip (see session-transcript's assistantParts).
 */
function restorePlan(taskId: string, messages: ChatMessage[]): void {
  usePlan.getState().replace(
    taskId,
    foldPlan(messages.flatMap((message) => message.tools ?? [])),
  );
}

/** Repaint a task's chat from a stored transcript without tripping the autosave. */
async function repaint(taskId: string): Promise<Error | null> {
  restoringTasks.add(taskId);
  try {
    const meta = useSessions.getState().sessions.find((session) => session.id === taskId);
    if (!meta) throw new Error(`Session ${taskId} is not in the active scope`);
    const messages = await backendLoad(meta);
    getChatStore(taskId).getState().load(messages);
    restorePlan(taskId, messages);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    restoringTasks.delete(taskId);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Replace the display/cache projection from Pi's authoritative active branch.
 * A late response is discarded after any navigation. Cache corruption is only
 * surfaced when native recovery also fails, because a successful refresh repairs it.
 */
async function hydrateNativeTranscript(
  meta: ChatSessionMeta,
  epoch: number,
  cacheError: Error | null
): Promise<void> {
  try {
    const response = await getPiClient(meta.id).request<PiEntriesSnapshot>({ type: "get_entries" });
    if (!response.success || !response.data) {
      throw new Error(response.error || "Pi returned no session entries");
    }
    const messages = sessionEntriesToChatMessages(response.data);
    const state = useSessions.getState();
    if (epoch !== hydrationEpoch || state.activeId !== meta.id) return;

    restoringTasks.add(meta.id);
    try {
      getChatStore(meta.id).getState().load(messages);
      restorePlan(meta.id, messages);
    } finally {
      restoringTasks.delete(meta.id);
    }

    const current = useSessions.getState().sessions.find((session) => session.id === meta.id);
    if (!current) return;
    const refreshed: ChatSessionMeta = {
      ...current,
      name: current.name || deriveName(messages),
      preview: derivePreview(messages),
      updatedAt: Date.now(),
    };
    useSessions.setState((sessionsState) => ({
      sessions: sessionsState.sessions
        .map((session) => (session.id === meta.id ? refreshed : session))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }));
    await backendSave(refreshed, messages);
  } catch (error) {
    if (epoch !== hydrationEpoch || useSessions.getState().activeId !== meta.id) return;
    if (cacheError) {
      useExtUi.getState().pushToast(
        t("session.cacheAndNativeRestoreFailed", { error: errorText(error).slice(0, 240) }),
        "error",
        10_000
      );
    } else if ((meta.executionBinding?.kind ?? "local") === "local") {
      useExtUi.getState().pushToast(
        t("session.nativeRefreshFailed", { error: errorText(error).slice(0, 240) }),
        "warning",
        8_000
      );
    }
  }
}

/** Attach autosave + title generation to a task's chat store (once per task). */
function hookAutosave(taskId: string) {
  if (autosaved.has(taskId)) return;
  autosaved.add(taskId);
  getChatStore(taskId).subscribe((s, prev) => {
    if (restoringTasks.has(taskId) || s.messages === prev.messages) return;
    scheduleSave(taskId);
    void generateInitialTitle(taskId, s.messages);
  });
}

/**
 * Bring a task's pi process up: init its chat store, attach autosave, and spawn
 * its own `pi --mode rpc` process (resuming `resumePath` when available).
 * Idempotent — a task whose process is already running is left untouched.
 */
async function ensureTaskStarted(
  taskId: string,
  opts: { cwd?: string; resumePath?: string; executionBinding?: ExecutionBinding }
): Promise<void> {
  const chat = getChatStore(taskId);
  if (!chat.getState().initialized) chat.getState().init();
  hookAutosave(taskId);

  // Detached start is write-ahead: both the pending id and the host acknowledgement
  // are durably saved before the process port is allowed to attach.
  let binding = opts.executionBinding;
  let attachAfter: number | undefined;
  if (binding !== undefined && binding.kind === "ssh") {
    const prepared = await prepareRemoteBinding(binding, (next) =>
      persistExecutionBinding(taskId, next),
    );
    const completed = prepared.binding;
    binding = completed;
    // A replaced task is a different journal, so a cursor from the old one would resume
    // at a sequence that means something else entirely. Start from the beginning of the
    // new one instead.
    attachAfter = prepared.taskReplaced ? undefined : appliedSequenceFor(taskId);
  }

  const pi = getPiStore(taskId, binding);
  if (pi.getState().status === "disconnected") {
    await pi.getState().connect({
      cwd: opts.cwd,
      resumePath: opts.resumePath,
      executionBinding: binding,
      attachAfter,
    });
  }

  if (pi.getState().status === "disconnected") return;

  liveTasks.add(taskId);

  // Re-sync sessionPath on every `session` announcement. This covers both a
  // slow first boot (the initial call can land before pi answers get_state) and
  // every later move to a different session file — restart-without-resume,
  // fork, clone. The client outlives process restarts, so this stays attached.
  if (!syncListenerHooked.has(taskId)) {
    syncListenerHooked.add(taskId);
    getPiClient(taskId).on("session", () => {
      void syncSessionPath(taskId);
    });
  }
  void syncSessionPath(taskId);
}

/** Tear down every task process and store (switching projects). */
function resetTaskRegistry(): void {
  hydrationEpoch += 1;
  disposeAllPiClients();
  liveTasks.clear();
  autosaved.clear();
  restoringTasks.clear();
  syncListenerHooked.clear();
  sessionPathSynced.clear();
  sessionPathSyncing.clear();
  sessionPathWarningFor.clear();
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  clearChatStores();
  clearPiStores();
}

/** Begin an empty conversation in `projectRoot` as its own new task/process. */
async function startFresh(projectRoot: string): Promise<void> {
  const meta = createMeta(projectRoot, useSessions.getState().executionBinding);
  setActiveTaskId(meta.id);
  setSessionTitle(meta.id, "");
  useSessions.setState((s) => ({
    sessions: [meta, ...s.sessions],
    activeId: meta.id,
  }));
  // Establish the session row before detached write-ahead binding updates begin.
  await backendSave(meta, []);
  await ensureTaskStarted(meta.id, {
    cwd: cwdForBinding(meta.executionBinding, projectRoot),
    executionBinding: meta.executionBinding,
  });
}

/* ── store ── */

export const useSessions = create<SessionsStore>((set, get) => ({
  sessions: [],
  activeId: null,
  initialized: false,
  projectRoot: "",
  executionBinding: LOCAL_EXECUTION_BINDING,
  setExecutionBinding: (executionBinding) => set({ executionBinding }),
  switchExecutionTarget: async (executionBinding, localProjectRoot) => {
    const scope = executionScopeKey(executionBinding, localProjectRoot);
    const active = get().sessions.find((session) => session.id === get().activeId);
    if (get().initialized && get().projectRoot === scope && sameExecutionScope(active?.executionBinding, executionBinding)) {
      set({ executionBinding });
      // Still announce: this early return also covers the first switch onto a
      // target whose scope already matches, and the workspace may not have been
      // pointed at it yet. `retarget` is a no-op when nothing changed.
      announceExecutionTarget(executionBinding);
      return;
    }

    await flushSave();
    resetTaskRegistry();
    set({
      initialized: true,
      projectRoot: scope,
      sessions: [],
      activeId: null,
      executionBinding,
    });
    // The tree and open documents belong to the previous host and cannot be
    // reinterpreted against this one — same path, different file. Before this
    // existed, switching to an SSH target left the local project on screen with
    // nothing marking it as stale.
    announceExecutionTarget(executionBinding);

    const sessions = await backendList(scope, executionBinding);
    set({ sessions });
    sessions.forEach((session) => setSessionTitle(session.id, session.name));
    const compatible = sessions.find((session) => sameExecutionScope(session.executionBinding, executionBinding));
    if (compatible) {
      set({ activeId: compatible.id });
      setActiveTaskId(compatible.id);
      const epoch = ++hydrationEpoch;
      const cacheError = await repaint(compatible.id);
      await ensureTaskStarted(compatible.id, {
        cwd: executionBinding.kind === "ssh" ? executionBinding.remoteCwd : localProjectRoot || undefined,
        resumePath: compatible.sessionPath || undefined,
        executionBinding: compatible.executionBinding,
      });
      await hydrateNativeTranscript(compatible, epoch, cacheError);
      return;
    }

    if (sessions.length > 0 && executionBinding.kind === "ssh") {
      useExtUi.getState().pushToast(t("session.remoteProfileChanged"), "warning", 8000);
    }
    await startFresh(scope);
  },

  init: async (projectRoot) => {
    if (get().initialized) return;
    const key = projectKey(projectRoot);
    set({ initialized: true, projectRoot: key });

    const sessions = await backendList(key);
    set({ sessions });
    sessions.forEach((s) => setSessionTitle(s.id, s.name));
    // Background-completion notifications use this to focus their conversation.
    setFocusSessionHandler((id) => {
      void useSessions.getState().switchSession(id);
    });

    const latest = sessions[0];
    if (latest) {
      set({ activeId: latest.id, executionBinding: latest.executionBinding ?? LOCAL_EXECUTION_BINDING });
      setActiveTaskId(latest.id);
      // Refresh-restore: repaint the newest conversation and spawn its process
      // with --session so the agent loop has the full prior context.
      const epoch = ++hydrationEpoch;
      const cacheError = await repaint(latest.id);
      await ensureTaskStarted(latest.id, {
        cwd: cwdForBinding(latest.executionBinding, key),
        resumePath: latest.sessionPath || undefined,
        executionBinding: latest.executionBinding,
      });
      await hydrateNativeTranscript(latest, epoch, cacheError);
    } else {
      await startFresh(key);
    }

    // best-effort flush on refresh/close (localStorage path is synchronous)
    window.addEventListener("beforeunload", () => void flushSave());
  },

  switchProject: async (projectRoot) => {
    const key = projectKey(projectRoot);
    if (get().initialized && key === get().projectRoot) return;
    await flushSave(); // persist the outgoing project's transcripts first

    // A different cwd means every old-project process must go — their session
    // files live under the previous project root.
    resetTaskRegistry();
    set({ initialized: true, projectRoot: key, sessions: [], activeId: null });
    setActiveTaskId(getActiveTaskId() || DEFAULT_TASK_ID);

    const sessions = await backendList(key, get().executionBinding);
    set({ sessions });
    sessions.forEach((s) => setSessionTitle(s.id, s.name));

    const latest = sessions[0];
    if (latest) {
      set({ activeId: latest.id, executionBinding: latest.executionBinding ?? LOCAL_EXECUTION_BINDING });
      setActiveTaskId(latest.id);
      const epoch = ++hydrationEpoch;
      const cacheError = await repaint(latest.id);
      await ensureTaskStarted(latest.id, {
        cwd: cwdForBinding(latest.executionBinding, key),
        resumePath: latest.sessionPath || undefined,
        executionBinding: latest.executionBinding,
      });
      await hydrateNativeTranscript(latest, epoch, cacheError);
    } else {
      await startFresh(key);
    }
  },

  newSession: async () => {
    const { activeId, sessions, projectRoot } = get();
    const active = sessions.find((s) => s.id === activeId);
    // reuse an untouched session instead of stacking empty ones
    if (active && getChatStore(active.id).getState().messages.length === 0) return;
    await flushSave();
    await startFresh(projectRoot);
  },

  switchSession: async (id) => {
    if (id === get().activeId) return;
    await flushSave();
    const meta = get().sessions.find((s) => s.id === id);
    const executionBinding = meta?.executionBinding ?? LOCAL_EXECUTION_BINDING;
    set({ activeId: id, executionBinding });
    setActiveTaskId(id);

    const sessionPath = meta?.sessionPath ?? "";

    if (!liveTasks.has(id) && !sessionPath) {
      // No session path was ever persisted for this conversation — pi cannot
      // resume prior context. Start the task fresh and tell the user explicitly.
      useExtUi.getState().pushToast(t("session.contextLost"), "warning", 8000);
    }
    const shouldHydrate = !liveTasks.has(id);
    const epoch = ++hydrationEpoch;
    let cacheError: Error | null = null;
    if (shouldHydrate) {
      cacheError = await repaint(id);
    }

    const localRoot = sessionDependencies().projectRoot() ?? get().projectRoot;
    await ensureTaskStarted(id, {
      cwd: cwdForBinding(executionBinding, localRoot),
      resumePath: sessionPath || undefined,
      executionBinding,
    });
    if (meta && shouldHydrate) {
      await hydrateNativeTranscript(meta, epoch, cacheError);
    }
  },

  renameSession: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const target = get().sessions.find((session) => session.id === id);
    if (!target) return;
    setSessionTitle(id, trimmed);
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, name: trimmed } : x)),
    }));
    try {
      await backendRename(target, trimmed);
    } catch {
      // keep the optimistic rename — it will persist with the next save
    }
    if (id === get().activeId && sessionDependencies().desktopFeatures) {
      // Keep Pi's own session picker in sync with the desktop-side history.
      void syncPiSessionName(id, trimmed);
    }
  },

  deleteSession: async (id) => {
    // Read before the row goes: the pinned transcript path is the only handle on
    // pi's own session file, and it lives on the record about to be removed.
    const target = get().sessions.find((x) => x.id === id);
    const transcript = trashableTranscript(target);
    if (!target) return;
    try {
      await backendDelete(target);
    } catch {
      return; // deletion failed — keep the row rather than lying about it
    }
    // Index row first, transcript second, never the reverse. If the file moved
    // while the row survived, the next launch would resume `--session` at a path
    // pi then recreates empty, so a delete the user was never told had succeeded
    // would quietly eat the conversation instead. This order can only leave an
    // orphan transcript — exactly where every delete before this already left it.
    if (transcript) {
      try {
        await backendTrashSessionFile(target, transcript);
      } catch {
        // Cleanup is best effort: an orphan transcript must not fail the delete.
      }
    }
    const wasActive = get().activeId === id;
    set((s) => ({
      sessions: s.sessions.filter((x) => x.id !== id),
      ...(wasActive ? { activeId: null } : {}),
    }));

    // The deleted conversation's process is no longer needed.
    disposePiClient(id);
    liveTasks.delete(id);
    autosaved.delete(id);
    restoringTasks.delete(id);
    syncListenerHooked.delete(id);
    sessionPathSynced.delete(id);
    sessionPathSyncing.delete(id);
    sessionPathWarningFor.delete(id);
    const timer = saveTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(id);
    }

    if (!wasActive) return;

    const next = get().sessions[0];
    if (next) {
      const meta = get().sessions.find((session) => session.id === next.id);
      const executionBinding = meta?.executionBinding ?? LOCAL_EXECUTION_BINDING;
      set({ activeId: next.id, executionBinding });
      setActiveTaskId(next.id);
      if (!liveTasks.has(next.id)) await repaint(next.id);
      const localRoot = sessionDependencies().projectRoot() ?? get().projectRoot;
      await ensureTaskStarted(next.id, {
        cwd: cwdForBinding(executionBinding, localRoot),
        resumePath: meta?.sessionPath || undefined,
        executionBinding,
      });
    } else {
      await startFresh(get().projectRoot);
    }
  },
}));