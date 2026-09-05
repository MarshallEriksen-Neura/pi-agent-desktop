/** Mock workspace files for the browser preview (Tauri uses the real FS bridge). */
export const WORKSPACE_FILES: Record<string, string> = {
  "src/lib/agent.ts": `import { buildContext } from "./context";
import { execute } from "./executor";
import type { Task, Plan } from "./types";

export async function runAgentLoop(task: Task) {
  const ctx = await buildContext(task);
  const plan = naivePlan(ctx);
  for (const step of plan.steps) {
    await execute(step);
  }
}

function naivePlan(ctx: unknown): Plan {
  // TODO: replace with real reasoning
  return { steps: [] };
}
`,
  "src/lib/store.ts": `import { create } from "zustand";

interface SessionState {
  sessions: string[];
  active: string | null;
  open: (id: string) => void;
}

export const useSessions = create<SessionState>((set) => ({
  sessions: [],
  active: null,
  open: (id) => set({ active: id }),
}));
`,
  "src/components/AgentPanel.tsx": `export function AgentPanel() {
  // Stacked task cards — iOS notification style.
  // Completed cards collapse upward and fade.
  return null;
}
`,
  "src/app/globals.css": `:root {
  --accent: #007aff;
  --bg-base: #ffffff;
}

:root[data-theme="dark"] {
  --accent: #0a84ff;
  --bg-base: #1c1c1e;
}
`,
};

/** The streaming edit the demo agent performs on agent.ts. */
export const DEMO_EDIT = {
  file: "src/lib/agent.ts",
  find: "  const plan = naivePlan(ctx);",
  replace: "  const plan = await reason(ctx, { depth: 3 });",
};
