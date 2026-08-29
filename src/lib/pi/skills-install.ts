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
import type { CliResultDto } from "../backend/ports";
import { getBackendKind, getPort } from "../backend/composition/container";
import { usePiSettings } from "./settings";
import { piHome, useSkills, type SkillInfo } from "./skills";
import { useWorkspace } from "../workspace";

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

/** CSI sequences, spelled without a literal escape byte in the source. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");

/**
 * Skill names and descriptions out of `skills add <source> --list`. The CLI has
 * no machine-readable mode; it logs through clack, which prefixes every line
 * with `│` — names at four spaces of indent, descriptions at six, and
 * unprefixed lines are plugin group headers.
 */
export function parseSkillList(stdout: string): SourceSkill[] {
  const lines = stdout.replace(ANSI, "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("Available Skills"));
  if (start < 0) return [];
  const out: SourceSkill[] = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^[│|](\s+)(\S.*?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1].length <= 5) out.push({ name: m[2], description: "" });
    else if (out.length > 0) out[out.length - 1].description = m[2];
  }
  return out;
}

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


/**
 * The CLI resolves a project-scoped install — and any relative local source —
 * against the process cwd, so every invocation runs inside the open project
 * when there is one. Global scope is selected by `-g`, not by the cwd.
 */
const cwdFor = () => useWorkspace.getState().root || null;

const run = (args: string[]) =>
  getPort("piConfiguration").runSkillsCli(args, cwdFor());

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** clack's gutter and status glyphs, which carry no information here. */
const GUTTER = /^[│|■◆◇◒◐◓◑●○└┌├─]+\s*/;
/** npx/npm chatter about the user's environment, not about the skill. */
const NPM_NOISE = /^npm (warn|WARN|notice)\b/;
/** clack outros that only repeat that something went wrong. */
const OUTRO = /^(Installation failed|Removal failed|Update failed|Canceled|Cancelled)$/;

/**
 * The CLI's own diagnosis, reduced to something a single row can show.
 *
 * Both streams have to be read. The failure text goes to stdout — clack logs
 * there — while stderr usually carries nothing but npm's warning about a config
 * key in the user's .npmrc. Preferring stderr therefore showed the noise and
 * hid the reason.
 */
export function cliError(r: CliResultDto, fallback: string): string {
  const lines = `${r.stdout}\n${r.stderr}`
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.replace(GUTTER, "").trim())
    .filter(
      (line) =>
        line &&
        !NPM_NOISE.test(line) &&
        !OUTRO.test(line) &&
        !line.startsWith("Tip:") &&
        // Spinner frames are rewritten in place, so stripping the cursor-move
        // sequences glues several of them (and the next gutter) into one line.
        // Every one carries the ellipsis the CLI marks progress with.
        !line.includes("…")
    );
  return lines.slice(-3).join(" · ").slice(-400) || fallback;
}

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
async function settle() {
  await useSkills.getState().scan();
  await useSkillsInstall.getState().loadLocks();
  usePiSettings.setState({ dirtyRestart: true });
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
    set({
      listing: true,
      listError: null,
      sourceSkills: null,
      sourceOpaque: false,
      selected: [],
    });
    try {
      // Runs in the project when one is open, so a relative local source
      // (`./my-skills`) resolves the way the user typed it. Nothing is written.
      const r = await run(listArgs(source));
      if (r.code !== 0) {
        throw new Error(cliError(r, `skills add --list exited with ${r.code}`));
      }
      const found = parseSkillList(r.stdout);
      set({
        listing: false,
        sourceSkills: found,
        sourceOpaque: found.length === 0,
        // A source that holds exactly one skill needs no picking.
        selected: found.length === 1 ? [found[0].name] : [],
      });
    } catch (e) {
      set({ listing: false, listError: msg(e) });
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
    if (scope === "project" && !cwdFor()) {
      set({ log: { ok: false, key: "skillsInstall.noProject" } });
      return;
    }
    set({ busy: token, log: null });
    try {
      const r = await run(addArgs(source, skills, scope));
      if (r.code !== 0) {
        throw new Error(cliError(r, `skills add exited with ${r.code}`));
      }
      await settle();
      set({
        log: {
          ok: true,
          key: "skillsInstall.installed",
          // `*` means "everything this source has" — name the source instead
          params: { name: skills.includes("*") ? source : skills.join(", ") },
        },
      });
    } catch (e) {
      set({
        log: { ok: false, key: "skillsInstall.installFailed", params: { err: msg(e) } },
      });
    } finally {
      set({ busy: null });
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
    set({ busy: `remove:${skill.file}`, log: null });
    try {
      const r = await run(removeArgs(skill.name, scope));
      if (r.code !== 0) {
        throw new Error(cliError(r, `skills remove exited with ${r.code}`));
      }
      await settle();
      set({
        log: { ok: true, key: "skillsInstall.removed", params: { name: skill.name } },
      });
    } catch (e) {
      set({
        log: { ok: false, key: "skillsInstall.removeFailed", params: { err: msg(e) } },
      });
    } finally {
      set({ busy: null });
    }
  },

  updateAll: async () => {
    if (get().busy) return;
    const scope = get().scope;
    if (scope === "project" && !cwdFor()) {
      set({ log: { ok: false, key: "skillsInstall.noProject" } });
      return;
    }
    set({ busy: "update", log: null });
    try {
      const r = await run(updateArgs(scope));
      if (r.code !== 0) {
        throw new Error(cliError(r, `skills update exited with ${r.code}`));
      }
      await settle();
      set({ log: { ok: true, key: "skillsInstall.updated" } });
    } catch (e) {
      set({
        log: { ok: false, key: "skillsInstall.updateFailed", params: { err: msg(e) } },
      });
    } finally {
      set({ busy: null });
    }
  },

  move: async (skill, to) => {
    if (get().busy) return;
    const from: InstallScope = to === "global" ? "project" : "global";
    if (skill.origin !== from) return; // already there, or a configured path
    if (to === "project" && !cwdFor()) {
      set({ log: { ok: false, key: "skillsInstall.noProject" } });
      return;
    }
    // Re-installing from the recorded source is what `skills update` itself
    // does; copying the directory would leave the target scope's lock empty and
    // silently opt the skill out of future updates.
    const source = get().locks?.[skill.name];
    if (!source) {
      set({
        log: { ok: false, key: "skillsInstall.moveUnavailable", params: { name: skill.name } },
      });
      return;
    }
    set({ busy: `move:${skill.file}`, log: null });
    try {
      const added = await run(addArgs(source, [skill.name], to));
      if (added.code !== 0) {
        throw new Error(cliError(added, `skills add exited with ${added.code}`));
      }
      const removed = await run(removeArgs(skill.name, from));
      await settle();
      set({
        log:
          removed.code === 0
            ? { ok: true, key: "skillsInstall.moved", params: { name: skill.name } }
            : {
                ok: false,
                key: "skillsInstall.moveHalfDone",
                params: { name: skill.name, err: cliError(removed, `exit ${removed.code}`) },
              },
      });
    } catch (e) {
      set({
        log: { ok: false, key: "skillsInstall.moveFailed", params: { err: msg(e) } },
      });
    } finally {
      set({ busy: null });
    }
  },

  loadLocks: async () => {
    if (getBackendKind() === "browser-preview") {
      set({
        locks: { "frontend-design": "https://github.com/vercel-labs/agent-skills.git" },
      });
      return;
    }
    const settings = usePiSettings.getState();
    if (!settings.loaded) await settings.load();
    const home = piHome(usePiSettings.getState().global.path);
    const root = useWorkspace.getState().root;
    const paths = [`${home}/.agents/.skill-lock.json`];
    // The project lock sits at the repo root and is meant to be committed.
    if (root) paths.push(`${root.replace(/\\/g, "/")}/skills-lock.json`);

    const port = getPort("piConfiguration");
    const merged: Record<string, string> = {};
    await Promise.all(
      paths.map(async (path) => {
        try {
          Object.assign(merged, parseLock(await port.readSkillFile(path)));
        } catch {
          // no lock at this scope — nothing to merge
        }
      })
    );
    set({ locks: merged });
  },
}));
