"use client";

/**
 * Slash commands for the composer — built-ins that map onto pi RPC / local
 * actions, merged with extension commands reported by `get_commands`.
 */

import { getPiClient } from "./client";
import { usePi, type PiCommandInfo } from "./store";
import { useSessions } from "./sessions";
import { useSubagents } from "./subagents";
import { useUI } from "../store";
import type { TFunc } from "../i18n";

export interface BuiltinSlashCommand {
  name: string;
  /** i18n key for the one-line description shown in the menu. */
  descKey: string;
  /** Local action executed on submit; commands without one are sent to pi. */
  run?: () => void;
}

export const BUILTIN_COMMANDS: BuiltinSlashCommand[] = [
  {
    name: "new",
    descKey: "cmd.new",
    run: () => void useSessions.getState().newSession(),
  },
  {
    name: "compact",
    descKey: "cmd.compact",
    run: () => getPiClient().send({ type: "compact" }),
  },
  {
    name: "model",
    descKey: "cmd.model",
    run: () => void usePi.getState().cycleModel(),
  },
  {
    name: "thinking",
    descKey: "cmd.thinking",
    run: () => {
      void getPiClient()
        .request({ type: "cycle_thinking_level" })
        .then(() => usePi.getState().refresh());
    },
  },
  {
    name: "demo",
    descKey: "cmd.demo",
    run: () => {
      if (!useUI.getState().agentRunning) useUI.getState().startDemo();
    },
  },
  {
    name: "agents",
    descKey: "cmd.agents",
    run: () => useSubagents.getState().runDemo(),
  },
];

/** One row in the slash menu — built-in or extension-provided. */
export interface SlashItem {
  name: string;
  description: string;
  /** "builtin" or the extension name (e.g. "pi-review"). */
  source: string;
}

/**
 * Merge built-ins with pi-reported commands (built-ins win on name clashes)
 * and filter by the text typed after "/" — prefix matches sort first.
 */
export function filterSlashCommands(
  query: string,
  extCommands: PiCommandInfo[],
  t: TFunc
): SlashItem[] {
  const q = query.trim().toLowerCase();
  const builtins: SlashItem[] = BUILTIN_COMMANDS.map((c) => ({
    name: c.name,
    description: t(c.descKey),
    source: "builtin",
  }));
  const seen = new Set(builtins.map((b) => b.name));
  const ext: SlashItem[] = extCommands
    .filter((c) => c.name && !seen.has(c.name))
    .map((c) => ({
      name: c.name,
      description: c.description ?? "",
      source: c.source?.replace(/^extension:/, "") ?? "pi",
    }));
  return [...builtins, ...ext]
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.name.toLowerCase().startsWith(q)) -
        Number(a.name.toLowerCase().startsWith(q))
    );
}

/**
 * Run a submitted "/command …" locally when it's a built-in with an action.
 * Returns true when handled; false means the text should go to pi as a prompt.
 */
export function runBuiltinCommand(text: string): boolean {
  if (!text.startsWith("/")) return false;
  const name = text.slice(1).split(/\s+/)[0]?.toLowerCase();
  const builtin = BUILTIN_COMMANDS.find((c) => c.name === name);
  if (!builtin?.run) return false;
  builtin.run();
  return true;
}
