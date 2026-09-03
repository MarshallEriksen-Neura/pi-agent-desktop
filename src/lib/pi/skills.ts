"use client";

/**
 * Skill discovery — a view of `usePiManagement`'s snapshot, not a second scan.
 *
 * The scan itself lives on `PiManagementPort.inspect`: locally that is a
 * directory walk through `desktop/pi-management.ts`, remotely it is one
 * `--manage inspect` round trip that already carries every SKILL.md's
 * frontmatter. This store only maps that snapshot into the shape the skills
 * page has always rendered, so a stale walk here cannot disagree with the
 * management snapshot the plugins page is looking at.
 */

import { create } from "zustand";
import { usePiManagement } from "./management";

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

export const useSkills = create<SkillsStore>((set) => ({
  mock: false,
  loading: false,
  scanned: false,
  skills: [],
  unscannable: [],
  error: null,

  scan: async () => {
    const context = usePiManagement.getState().context();
    set({ loading: true, error: null, skills: [], unscannable: [] });
    try {
      await usePiManagement.getState().load();
      const management = usePiManagement.getState();
      if (management.context().targetKey !== context.targetKey) return;
      const snapshot = management.snapshot;
      if (!snapshot) {
        set({
          loading: false,
          scanned: true,
          skills: [],
          unscannable: [],
          error: management.error,
        });
        return;
      }
      set({
        mock:
          snapshot.targetKey.startsWith("local:") &&
          snapshot.skills.some((skill) => skill.sourceRef.startsWith("mock:")),
        loading: false,
        scanned: true,
        skills: snapshot.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          origin: skill.origin,
          dir: skill.sourceRef,
          file: skill.sourceRef,
        })),
        unscannable: snapshot.unscannableSkills,
        error: null,
      });
    } catch (error) {
      if (usePiManagement.getState().context().targetKey !== context.targetKey) return;
      set({
        loading: false,
        scanned: true,
        skills: [],
        unscannable: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  readSource: async (sourceRef) => {
    const management = usePiManagement.getState();
    const context = management.context();
    const source = await context.port.readSkillSource(sourceRef);
    if (usePiManagement.getState().context().targetKey !== context.targetKey) return "";
    return source;
  },
}));
