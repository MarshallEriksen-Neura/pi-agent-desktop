"use client";

/**
 * Skill discovery — mirrors the directories the running pi loads skills from
 * and parses each SKILL.md frontmatter (name, description).
 *
 * pi has no "list skills" RPC, so the desktop app scans via the Tauri fs
 * bridge, following pi's own resolution order:
 *   global : ~/.pi/agent/skills/<name>/SKILL.md
 *   project: <root>/.pi/skills/<name>/SKILL.md
 *   paths  : settings.json → skills[] — global entries resolve against
 *            ~/.pi/agent, project entries against <root>/.pi, ~ expands.
 * Glob and "!" exclude entries can't be expanded with fs_list_dir; they are
 * reported as `unscannable` so the UI can say the list may be partial.
 * In browser preview everything runs on mock data.
 */

import { create } from "zustand";
import { isTauri } from "./client";
import { usePiSettings } from "./settings";
import { useWorkspace } from "../workspace";

export type SkillOrigin = "global" | "project" | "path";

export interface SkillInfo {
  name: string;
  description: string;
  /** directory that contains the SKILL.md */
  dir: string;
  /** full path of the SKILL.md itself */
  file: string;
  origin: SkillOrigin;
}

interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** minimal YAML frontmatter reader — only the two keys pi's skill format uses */
function parseSkillMd(content: string, fallbackName: string) {
  let name = fallbackName;
  let description = "";
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = line.match(/^(name|description):\s*(.*)$/);
      if (!kv) continue;
      const v = kv[2].trim().replace(/^["']|["']$/g, "");
      if (kv[1] === "name" && v) name = v;
      else if (kv[1] === "description") description = v;
    }
  }
  return { name, description };
}

async function readFile(path: string): Promise<string | null> {
  try {
    return await tauriInvoke<string>("fs_read_file", { path });
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<FsEntry[]> {
  try {
    return await tauriInvoke<FsEntry[]>("fs_list_dir", { path });
  } catch {
    return []; // missing directory = zero skills, not an error
  }
}

/**
 * Skills inside one directory: the dir may itself be a skill (has SKILL.md)
 * or contain one skill per subdirectory.
 */
async function scanDir(dir: string, origin: SkillOrigin): Promise<SkillInfo[]> {
  const own = await readFile(`${dir}/SKILL.md`);
  if (own !== null) {
    const meta = parseSkillMd(own, dir.split("/").pop() ?? dir);
    return [{ ...meta, dir, file: `${dir}/SKILL.md`, origin }];
  }
  const entries = await listDir(dir);
  const out: SkillInfo[] = [];
  await Promise.all(
    entries
      .filter((e) => e.isDir)
      .map(async (e) => {
        const skillDir = norm(e.path);
        const file = `${skillDir}/SKILL.md`;
        const content = await readFile(file);
        if (content === null) return;
        const meta = parseSkillMd(content, e.name);
        out.push({ ...meta, dir: skillDir, file, origin });
      })
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const MOCK_SKILLS: SkillInfo[] = [
  {
    name: "frontend-design",
    description: "Distinctive, intentional visual design guidance when building new UI.",
    origin: "global",
    dir: "~/.pi/agent/skills/frontend-design",
    file: "~/.pi/agent/skills/frontend-design/SKILL.md",
  },
  {
    name: "commit-helper",
    description: "Write conventional commits from the staged diff.",
    origin: "global",
    dir: "~/.pi/agent/skills/commit-helper",
    file: "~/.pi/agent/skills/commit-helper/SKILL.md",
  },
  {
    name: "pdf-export",
    description: "Render markdown reports to print-ready PDF.",
    origin: "global",
    dir: "~/.pi/agent/skills/pdf-export",
    file: "~/.pi/agent/skills/pdf-export/SKILL.md",
  },
  {
    name: "api-conventions",
    description: "This repo's REST naming, error shape, and pagination rules.",
    origin: "project",
    dir: ".pi/skills/api-conventions",
    file: ".pi/skills/api-conventions/SKILL.md",
  },
  {
    name: "deploy-checklist",
    description: "Pre-release checks for the staging → production pipeline.",
    origin: "project",
    dir: ".pi/skills/deploy-checklist",
    file: ".pi/skills/deploy-checklist/SKILL.md",
  },
  {
    name: "team-review",
    description: "Review pull requests with the team's severity rubric.",
    origin: "path",
    dir: "~/dev/shared-skills/team-review",
    file: "~/dev/shared-skills/team-review/SKILL.md",
  },
];

const MOCK_SOURCE = `---
name: frontend-design
description: Distinctive, intentional visual design guidance when building new UI.
---

# Frontend Design

Approach every brief as a design lead: make deliberate, opinionated
choices about palette, typography, and layout that are specific to the
subject — and take one real aesthetic risk you can justify.
`;

interface SkillsStore {
  mock: boolean;
  loading: boolean;
  /** true after the first scan completes (even an empty one) */
  scanned: boolean;
  skills: SkillInfo[];
  /** settings.json skill entries we could not expand (globs / excludes) */
  unscannable: string[];
  error: string | null;

  scan: () => Promise<void>;
  /** raw SKILL.md content for the expanded row preview */
  readSource: (file: string) => Promise<string>;
}

export const useSkills = create<SkillsStore>((set, get) => ({
  mock: !isTauri(),
  loading: false,
  scanned: false,
  skills: [],
  unscannable: [],
  error: null,

  scan: async () => {
    if (get().mock) {
      set({ scanned: true, skills: MOCK_SKILLS, unscannable: [], error: null });
      return;
    }
    set({ loading: true, error: null });
    try {
      if (!usePiSettings.getState().loaded) await usePiSettings.getState().load();
      const s = usePiSettings.getState();
      const globalPath = norm(s.global.path); // …/.pi/agent/settings.json
      const agentDir = globalPath.replace(/\/settings\.json$/, "");
      const home = agentDir.replace(/\/\.pi\/agent$/, "");
      const rawRoot = useWorkspace.getState().root;
      const root = rawRoot ? norm(rawRoot) : null;

      const sources: { dir: string; origin: SkillOrigin }[] = [
        { dir: `${agentDir}/skills`, origin: "global" },
      ];
      if (root) sources.push({ dir: `${root}/.pi/skills`, origin: "project" });

      const unscannable: string[] = [];
      const addConfigured = (entries: string[] | undefined, base: string) => {
        for (const raw of entries ?? []) {
          if (raw.startsWith("!")) continue; // excludes only narrow other entries
          if (/[*?[\]]/.test(raw)) {
            unscannable.push(raw);
            continue;
          }
          let p = norm(raw.replace(/^~(?=\/|$)/, home));
          if (!/^([a-zA-Z]:)?\//.test(p)) p = `${base}/${p}`;
          sources.push({ dir: p, origin: "path" });
        }
      };
      addConfigured(s.global.data?.skills, agentDir);
      if (root) addConfigured(s.project.data?.skills, `${root}/.pi`);

      const seen = new Set<string>();
      const unique = sources.filter((src) => {
        if (seen.has(src.dir)) return false;
        seen.add(src.dir);
        return true;
      });
      const results = await Promise.all(unique.map((src) => scanDir(src.dir, src.origin)));
      set({ skills: results.flat(), unscannable, scanned: true, loading: false });
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
        loading: false,
        scanned: true,
      });
    }
  },

  readSource: async (file) => {
    if (get().mock) return MOCK_SOURCE;
    return tauriInvoke<string>("fs_read_file", { path: file });
  },
}));
