"use client";

/**
 * HTML preview for edit rows — the "agent wrote a page, let me see it" path.
 *
 * When an edit/write tool call targets an .html file, the transcript row grows
 * an "open in browser" affordance once the write lands. Detection lives here
 * rather than in the component so the transcript-restoration path (history has
 * the args but no live bridge) and the tests share one definition of what
 * qualifies.
 */

import { EDIT_TOOL, argPath, normPath } from "./tool-label";

const HTML_EXT = /\.html?$/i;

/**
 * The previewable file a tool call targets, normalized to the workspace path
 * style the desktop open command expects — or undefined when the call is not
 * an edit, has no path argument, or the path is not an HTML page.
 */
export function htmlEditTarget(toolName: string, rawArgs: unknown): string | undefined {
  if (!EDIT_TOOL.test(toolName)) return undefined;
  const p = argPath(
    typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {}
  );
  if (!p || !HTML_EXT.test(p)) return undefined;
  return normPath(p);
}
