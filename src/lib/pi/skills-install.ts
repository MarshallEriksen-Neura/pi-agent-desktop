"use client";

/**
 * Skill installation — pi has no skills subcommand of its own, so installing,
 * removing, updating and re-scoping skills all run through the upstream Skills
 * CLI (vercel-labs/skills). That CLI already targets exactly the directories
 * skills.ts scans (`~/.pi/agent/skills` globally, `<root>/.pi/skills` per
 * project), so a successful action plus a rescan is all the UI needs.
 *
 * Discovery hits `https://skills.sh/api/search`, the same anonymous endpoint the
 * CLI's own `find` command uses. The documented `/api/v1/*` API is not an
 * option: it requires a Vercel OIDC bearer token and 401s from here.
 *
 * Installs pass `--copy`. The CLI's default is a symlink into
 * `~/.agents/skills`, and a junction cannot be committed alongside a project's
 * `.pi/skills/`, which upstream intends to be checked in.
 */

import { create } from "zustand";
import { getPort } from "../backend/composition/container";
import { cliError } from "./cli-error";
import { usePiSettings } from "./settings";
import { useSkills, type SkillInfo } from "./skills";
import { usePiManagement, type ManagementContext } from "./management";
import { useWorkspace } from "../workspace";

export { parseSkillList } from "./skill-list-parser";
function isCurrentManagementTarget(context: ManagementContext): boolean {
  return usePiManagement.getState().context().targetKey === context.targetKey;
}

function currentSkillMutation() {
  const management = usePiManagement.getState();
  const context = management.context();
  const snapshot = management.snapshot;
  if (
    !snapshot ||
    management.targetKey !== context.targetKey ||
    snapshot.targetKey !== context.targetKey ||
    (context.binding.kind === "ssh" &&
      !management.availability?.capabilities.includes("pi-skills-mutate-v1"))
  ) return null;
  return { context, snapshot };
}

export type InstallScope = "global" | "project";

export interface CatalogHit {
  /** `<source>/<skillId>` — stable across searches, used as a react key */
  id: string;
  /** what goes after `--skill` */
  skillId: string;
  name: string;
  /** `owner/repo`, or a bare domain for well-known sources */
  source: string;
  installs: number;
}

export interface SourceSkill {
  name: string;
  description: string;
}

/** Kept structured so the message re-localizes when the locale changes. */
export interface ActionLog {
  ok: boolean;
  key: string;
  params?: Record<string, string | number>;
}

const AGENT = ["--agent", "pi"];
const scopeFlag = (scope: InstallScope) => (scope === "global" ? ["-g"] : []);

/**
 * `add <source> --skill a --skill b --agent pi [-g] --copy -y`
 *
 * Argument order is load-bearing: the CLI's `-a`/`-s` parsers keep swallowing
 * values until they hit the next `-`-prefixed argument, so the source must sit
 * directly after `add` and every skill needs its own `--skill`.
 */
export function addArgs(source: string, skills: string[], scope: InstallScope) {
  return [
    "add",
    source,
    ...skills.flatMap((name) => ["--skill", name]),
    ...AGENT,
    ...scopeFlag(scope),
    "--copy",
    "-y",
  ];
}

/** Enumerate what a source offers without installing any of it. */
export const listArgs = (source: string) => ["add", source, "--list"];

export const removeArgs = (name: string, scope: InstallScope) => [
  "remove",
  "--skill",
  name,
  ...AGENT,
  ...scopeFlag(scope),
  "-y",
];

export const updateArgs = (scope: InstallScope) => [
  "update",
  scope === "global" ? "-g" : "-p",
  "-y",
];


/**
 * A source reduced to the identity the catalogue uses, so a lock entry can be
 * compared with a search hit: `https://github.com/o/r.git`,
 * `git@github.com:o/r.git` and `https://github.com/o/r/tree/main/skills/x` all
 * mean `o/r`. Anything that is not a remote URL — `owner/repo`, a bare domain,
 * a local path — is already in that form and is returned untouched.
 */
export function normalizeSource(raw: string): string {
  const trimmed = raw.trim();
  const scp = /^[^@\s/]+@[^:/]+:(.+)$/.exec(trimmed);
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(trimmed);
  const path = scp?.[1] ?? url?.[1];
  if (!path) return trimmed;
  const parts = path.replace(/\.git$/, "").split("/").filter(Boolean);
  return parts.slice(0, 2).join("/") || trimmed;
}

/**
 * skill name → the source it was installed from, out of one of the CLI's lock
 * files. `source` is the normalized identifier the catalogue also reports;
 * `sourceUrl` is the raw remote, kept as a fallback for older entries.
 */
export function parseLock(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const parsed = JSON.parse(content) as {
      skills?: Record<string, { sourceUrl?: string; source?: string }>;
    };
    for (const [name, entry] of Object.entries(parsed.skills ?? {})) {
      const source = entry?.source || entry?.sourceUrl;
      if (source) out[name] = normalizeSource(source);
    }
  } catch {
    // absent or malformed — callers treat a missing entry as "cannot move"
  }
  return out;
}


const msg = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
/**
 * The CLI resolves a project-scoped install — and any relative local source —
 * against the process cwd, so every invocation runs inside the open project
 * when there is one. Global scope is selected by `-g`, not by the cwd.
 */
const hasProject = () =>
  usePiManagement.getState().context().binding.kind === "ssh" || Boolean(useWorkspace.getState().root);
export { cliError } from "./cli-error";

/**
 * Whether the field names a place to fetch from rather than a skill to look up.
 * A source is `owner/repo`, a URL, a bare domain, or a path — all of which carry
 * a separator. A bare word is a skill name, so it goes to the catalogue.
 */
export const looksLikeSource = (input: string) => /[/\\:.~]/.test(input.trim());

/**
 * Exact name matches first, then by install count. The catalogue answers a name
 * query with both the skill asked for — often the same name from a dozen
 * different repos — and that skill's siblings, and the siblings can easily out-
 * rank the real answers on installs alone.
 */
export function rankHits(hits: CatalogHit[], query: string): CatalogHit[] {
  const needle = query.trim().toLowerCase();
  return [...hits].sort((a, b) => {
    const exact = Number(b.name.toLowerCase() === needle) -
      Number(a.name.toLowerCase() === needle);
    return exact !== 0 ? exact : b.installs - a.installs;
  });
}

/**
 * Re-read what is on disk and surface the restart prompt: pi loads skills when
 * a session starts, so an install is not live until it restarts.
 */
async function settle(
  snapshot: import("../backend/ports/pi-management").PiManagementSnapshot,
  dirtyScope: InstallScope,
  mutationContext: ManagementContext,
 ): Promise<boolean> {
  const state = usePiManagement.getState();
  const applied = state.applySnapshot(mutationContext.targetKey, snapshot);
  state.markDirty(dirtyScope, mutationContext);
  if (!applied) return false;
  await useSkills.getState().scan();
  if (!isCurrentManagementTarget(mutationContext)) return false;
  await useSkillsInstall.getState().loadLocks();
  if (mutationContext.binding.kind === "local") usePiSettings.setState({ dirtyRestart: true });
  return true;
}

interface SkillsInstallStore {
  /** where the next install lands */
  scope: InstallScope;
  setScope: (scope: InstallScope) => void;

  /**
   * One field for both ways in: a name searches the skills.sh catalogue as you
   * type, a source (`owner/repo`, URL, path) is enumerated on demand.
   */
  input: string;
  setInput: (input: string) => void;

  /** catalogue search — name mode */
  searching: boolean;
  hits: CatalogHit[] | null;
  searchError: string | null;
  search: () => Promise<void>;

  /** `--list` enumeration — source mode */
  listing: boolean;
  sourceSkills: SourceSkill[] | null;
  /** `--list` exited clean but parsed to nothing — only "install all" is left */
  sourceOpaque: boolean;
  listError: string | null;
  selected: string[];
  browse: () => Promise<void>;
  toggle: (name: string) => void;

  /** one CLI action at a time; the value names the row that owns it */
  busy: string | null;
  log: ActionLog | null;
  dismissLog: () => void;

  install: (source: string, skills: string[], token?: string) => Promise<void>;
  uninstall: (skill: SkillInfo) => Promise<void>;
  updateAll: () => Promise<void>;
  move: (skill: SkillInfo, to: InstallScope) => Promise<void>;

  /** skill name → re-install source, merged from the CLI's two lock files */
  locks: Record<string, string> | null;
  loadLocks: () => Promise<void>;
}

/** Debounce for catalog search — one timer for the single store instance. */
let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useSkillsInstall = create<SkillsInstallStore>((set, get) => ({
  scope: "global",
  input: "",
  searching: false,
  hits: null,
  searchError: null,
  listing: false,
  sourceSkills: null,
  sourceOpaque: false,
  listError: null,
  selected: [],
  busy: null,
  log: null,
  locks: null,

  setScope: (scope) => set({ scope }),
  dismissLog: () => set({ log: null }),

  setInput: (input) => {
    set({ input });
    if (searchTimer) clearTimeout(searchTimer);
    // A source has to be cloned, which runs into tens of seconds — that only
    // ever happens on an explicit browse, never while someone is typing.
    if (looksLikeSource(input)) {
      set({ hits: null, searching: false, searchError: null });
      return;
    }
    set({ sourceSkills: null, sourceOpaque: false, listError: null, selected: [] });
    // The endpoint rejects one-character queries; treat them as "cleared".
    if (input.trim().length < 2) {
      set({ hits: null, searching: false, searchError: null });
      return;
    }
    set({ searching: true });
    searchTimer = setTimeout(() => void get().search(), 300);
  },

  search: async () => {
    const q = get().input.trim();
    if (q.length < 2) return;
    set({ searching: true, searchError: null });
    try {
      const hits = await getPort("piConfiguration").searchSkills(q, 20);
      // A slower earlier keystroke must not overwrite a newer result.
      if (get().input.trim() !== q) return;
      set({ searching: false, hits: rankHits(hits, q) });
    } catch (e) {
      set({ searching: false, hits: [], searchError: msg(e) });
    }
  },

  browse: async () => {
    const source = get().input.trim();
    if (!source || get().listing) return;
    // Only a source can be enumerated; a bare name is the catalogue's job.
    if (!looksLikeSource(source)) return;
    const management = usePiManagement.getState();
    const context = management.context();
    const targetKey = context.targetKey;
    set({
      listing: true,
      listError: null,
      sourceSkills: null,
      sourceOpaque: false,
      selected: [],
    });
    try {
      const found = await context.port.browseSkillSource(source);
      if (!isCurrentManagementTarget(context) || get().input.trim() !== source) return;
      set({
        listing: false,
        sourceSkills: found,
        sourceOpaque: found.length === 0,
        // A source that holds exactly one skill needs no picking.
        selected: found.length === 1 ? [found[0].name] : [],
      });
    } catch (e) {
      if (usePiManagement.getState().targetKey === targetKey && get().input.trim() === source) {
        set({ listing: false, listError: msg(e) });
      }
    }
  },

  toggle: (name) =>
    set((s) => ({
      selected: s.selected.includes(name)
        ? s.selected.filter((n) => n !== name)
        : [...s.selected, name],
    })),

  install: async (source, skills, token = "source") => {
    if (get().busy || skills.length === 0) return;
    const scope = get().scope;
    if (scope === "project" && !hasProject()) {
      set({ log: { ok: false, key: "skillsInstall.noProject" } });
      return;
    }
    const mutation = currentSkillMutation();
    if (!mutation) {
      set({ log: { ok: false, key: "skillsInstall.managementUnavailable" } });
      return;
    }
    const { context, snapshot } = mutation;
    set({ busy: token, log: null });
    try {
      const result = await context.port.mutateSkill({
        operation: "install",
        scope,
        source,
        skills,
        expectedState: snapshot.stateToken,
      });
      if (!isCurrentManagementTarget(context)) return;
      if (!(await settle(result.snapshot, scope, context))) return;
      if (result.code !== 0) {
        throw new Error(cliError(result, `skills add exited with ${result.code}`));
      }
      set({
        log: {
          ok: true,
          key: "skillsInstall.installed",
          // `*` means "everything this source has" — name the source instead
          params: { name: skills.includes("*") ? source : skills.join(", ") },
        },
      });
    } catch (e) {
      if (isCurrentManagementTarget(context)) {
        set({ log: { ok: false, key: "skillsInstall.installFailed", params: { err: msg(e) } } });
      }
    } finally {
      if (isCurrentManagementTarget(context)) set({ busy: null });
    }
  },

  uninstall: async (skill) => {
    if (get().busy) return;
    if (skill.origin === "path") {
      // Outside pi's own two directories, so `remove --agent pi` can't see it.
      set({ log: { ok: false, key: "skillsInstall.removePathScope" } });
      return;
    }
    const scope: InstallScope = skill.origin;
    const mutation = currentSkillMutation();
    if (!mutation) {
      set({ log: { ok: false, key: "skillsInstall.managementUnavailable" } });
      return;
    }
    const { context, snapshot } = mutation;
    set({ busy: `remove:${skill.file}`, log: null });
    try {
      const result = await context.port.mutateSkill({
        operation: "remove",
        scope,
        name: skill.name,
        expectedState: snapshot.stateToken,
      });
      if (!isCurrentManagementTarget(context)) return;
      if (!(await settle(result.snapshot, scope, context))) return;
      if (result.code !== 0) {
        throw new Error(cliError(result, `skills remove exited with ${result.code}`));
      }
      set({
        log: { ok: true, key: "skillsInstall.removed", params: { name: skill.name } },
      });
    } catch (e) {
      if (isCurrentManagementTarget(context)) {
        set({ log: { ok: false, key: "skillsInstall.removeFailed", params: { err: msg(e) } } });
      }
    } finally {
      if (isCurrentManagementTarget(context)) set({ busy: null });
    }
  },

  updateAll: async () => {
    if (get().busy) return;
    const scope = get().scope;
    if (scope === "project" && !hasProject()) {
      set({ log: { ok: false, key: "skillsInstall.noProject" } });
      return;
    }
    const mutation = currentSkillMutation();
    if (!mutation) {
      set({ log: { ok: false, key: "skillsInstall.managementUnavailable" } });
      return;
    }
    const { context, snapshot } = mutation;
    set({ busy: "update", log: null });
    try {
      const result = await context.port.mutateSkill({
        operation: "updateAll",
        scope,
        expectedState: snapshot.stateToken,
      });
      if (!isCurrentManagementTarget(context)) return;
      if (!(await settle(result.snapshot, scope, context))) return;
      if (result.code !== 0) {
        throw new Error(cliError(result, `skills update exited with ${result.code}`));
      }
      set({ log: { ok: true, key: "skillsInstall.updated" } });
    } catch (e) {
      if (isCurrentManagementTarget(context)) {
        set({ log: { ok: false, key: "skillsInstall.updateFailed", params: { err: msg(e) } } });
      }
    } finally {
      if (isCurrentManagementTarget(context)) set({ busy: null });
    }
  },

  move: async (skill, to) => {
    if (get().busy) return;
    const from: InstallScope = to === "global" ? "project" : "global";
    if (skill.origin !== from) return; // already there, or a configured path
    if (to === "project" && !hasProject()) {
      set({ log: { ok: false, key: "skillsInstall.noProject" } });
      return;
    }
    const source = get().locks?.[skill.name];
    if (!source) {
      set({
        log: { ok: false, key: "skillsInstall.moveUnavailable", params: { name: skill.name } },
      });
      return;
    }
    const mutation = currentSkillMutation();
    if (!mutation) {
      set({ log: { ok: false, key: "skillsInstall.managementUnavailable" } });
      return;
    }
    const { context, snapshot } = mutation;
    set({ busy: `move:${skill.file}`, log: null });
    try {
      const result = await context.port.mutateSkill({
        operation: "move",
        from,
        to,
        name: skill.name,
        source,
        expectedState: snapshot.stateToken,
      });
      if (!isCurrentManagementTarget(context)) return;
      if (!(await settle(result.snapshot, "global", context))) return;
      set({
        log:
          result.code === 0
            ? { ok: true, key: "skillsInstall.moved", params: { name: skill.name } }
            : result.halfDone
              ? {
                  ok: false,
                  key: "skillsInstall.moveHalfDone",
                  params: { name: skill.name, err: cliError(result, `exit ${result.code}`) },
                }
              : {
                  ok: false,
                  key: "skillsInstall.moveFailed",
                  params: { err: cliError(result, `exit ${result.code}`) },
                },
      });
    } catch (e) {
      if (isCurrentManagementTarget(context)) {
        set({ log: { ok: false, key: "skillsInstall.moveFailed", params: { err: msg(e) } } });
      }
    } finally {
      if (isCurrentManagementTarget(context)) set({ busy: null });
    }
  },

  loadLocks: async () => {
    const snapshot = usePiManagement.getState().snapshot;
    set({ locks: snapshot ? { ...snapshot.skillLocks } : {} });
  },
}));
