"use client";

import { create } from "zustand";

/**
 * Terminal blocks store — command blocks (user-entered and agent-executed).
 * Each block is one command invocation with its output, status, timing.
 * This is the data model for the Wave/Warp-style block-based terminal view.
 */

export type BlockStatus = "running" | "success" | "error" | "cancelled";
export type BlockSource = "user" | "agent";

export interface TerminalBlock {
  id: string;
  source: BlockSource;
  command: string;
  /** ANSI-escaped output (streaming, cumulative) */
  output: string;
  status: BlockStatus;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  /** agent tool call ID if source=agent */
  toolCallId?: string;
  /** collapsed in the UI */
  collapsed: boolean;
}

interface TerminalBlocksState {
  blocks: TerminalBlock[];
  /** view mode: "blocks" (card-based) or "classic" (full xterm canvas) */
  viewMode: "blocks" | "classic";
  /**
   * The command line being edited in block mode.
   *
   * Store state rather than component state because the context menu's Paste is
   * rendered outside the input's tree and still has to write into it — and it
   * costs nothing to keep a half-typed command across a view-mode toggle.
   */
  input: string;

  addBlock: (block: Omit<TerminalBlock, "id" | "collapsed">) => string;
  updateBlock: (id: string, patch: Partial<TerminalBlock>) => void;
  appendOutput: (id: string, delta: string) => void;
  toggleCollapse: (id: string) => void;
  clearBlocks: () => void;
  setViewMode: (mode: "blocks" | "classic") => void;
  setInput: (value: string) => void;
}

let seq = 0;

export const useTerminalBlocks = create<TerminalBlocksState>((set) => ({
  blocks: [],
  viewMode: "blocks",
  input: "",

  addBlock: (block) => {
    const id = `tb-${Date.now()}-${++seq}`;
    const full: TerminalBlock = { ...block, id, collapsed: false };
    set((s) => ({ blocks: [...s.blocks, full] }));
    return id;
  },

  updateBlock: (id, patch) =>
    set((s) => ({
      blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    })),

  appendOutput: (id, delta) =>
    set((s) => ({
      blocks: s.blocks.map((b) =>
        b.id === id ? { ...b, output: b.output + delta } : b
      ),
    })),

  toggleCollapse: (id) =>
    set((s) => ({
      blocks: s.blocks.map((b) =>
        b.id === id ? { ...b, collapsed: !b.collapsed } : b
      ),
    })),

  clearBlocks: () => set({ blocks: [] }),

  setViewMode: (mode) => set({ viewMode: mode }),

  setInput: (value) => set({ input: value }),
}));
