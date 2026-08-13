import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";
import type { OutputFragment } from "@/stores/task-store";

/**
 * Transcript builder — folds the gateway's flat output stream into a readable
 * conversation.
 *
 * Why this exists: the gateway forwards assistant prose as `text_delta`
 * fragments, so a single sentence arrives as many `stdout` events. Rendering one
 * block per fragment (the old TaskDetailPage behaviour) shreds a paragraph into
 * a dozen grey boxes. Here consecutive `stdout` fragments are concatenated into
 * one assistant message instead.
 *
 * Ordering: fragments carry a monotonic `sequence` from the event stream;
 * interactions only have timestamps. Everything is merged onto one timeline
 * sorted by time so an interaction lands where it actually happened — which also
 * means an interaction naturally breaks a run of stdout into two messages.
 *
 * This module is pure so it can be unit-tested without a live connection.
 */

export interface ToolInvocation {
  /** Tool name (`edit`, `read`, `bash`, …). */
  readonly name: string;
  /** File path or command the tool acted on. Empty when the tool sent none. */
  readonly target: string;
  /** True once the tool finished (`tool_execution_end`). */
  readonly ended: boolean;
  readonly isError: boolean;
}

export type TranscriptEntry =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      readonly at: string;
    }
  | { readonly kind: "tool"; readonly id: string; readonly tool: ToolInvocation }
  | { readonly kind: "warning"; readonly id: string; readonly text: string }
  | { readonly kind: "system"; readonly id: string; readonly text: string }
  | {
      readonly kind: "interaction";
      readonly id: string;
      readonly interaction: RemoteInteractionSnapshot;
    };

/** Compact tool payload as emitted by the Rust gateway's `classify_tool_event`. */
interface ToolPayload {
  n?: unknown;
  p?: unknown;
  d?: unknown;
  e?: unknown;
}

/**
 * Parse a `tool` fragment. Returns null when the payload isn't usable —
 * `emit_output` truncates by char count, so a long payload can legitimately
 * arrive as broken JSON. Callers render the raw text instead of dropping it.
 */
export function parseToolFragment(fragment: string): ToolInvocation | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fragment);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as ToolPayload;
  if (typeof payload.n !== "string" || payload.n.length === 0) return null;
  return {
    name: payload.n,
    target: typeof payload.p === "string" ? payload.p : "",
    ended: payload.d === true,
    isError: payload.e === true,
  };
}

/** Milliseconds for ordering; NaN-safe so a bad timestamp never reshuffles. */
function timeOf(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

type TimelineItem =
  | { readonly type: "fragment"; readonly at: number; readonly seq: number; readonly value: OutputFragment }
  | {
      readonly type: "interaction";
      readonly at: number;
      readonly seq: number;
      readonly value: RemoteInteractionSnapshot;
    };

/**
 * Build the ordered transcript.
 *
 * @param prompt   The submitted prompt, from the local cache. `RemoteTaskSnapshot`
 *                 never carries it, so pass null when unknown — no fake bubble
 *                 is invented.
 * @param fragments Output fragments for this task, in arrival order.
 * @param interactions Interactions belonging to this task.
 */
export function buildTranscript(
  prompt: string | null,
  fragments: readonly OutputFragment[],
  interactions: readonly RemoteInteractionSnapshot[],
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  if (prompt && prompt.trim().length > 0) {
    entries.push({ kind: "user", id: "prompt", text: prompt });
  }

  const timeline: TimelineItem[] = [
    ...fragments.map<TimelineItem>((value) => ({
      type: "fragment",
      at: timeOf(value.emittedAt),
      seq: value.sequence,
      value,
    })),
    ...interactions.map<TimelineItem>((value, i) => ({
      type: "interaction",
      at: timeOf(value.createdAt),
      // Interactions have no sequence; keep their relative order stable.
      seq: i,
      value,
    })),
  ];

  // Stable sort by time, then by sequence within the same instant. Fragments win
  // ties against interactions so prose that preceded a request stays above it.
  timeline.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.type !== b.type) return a.type === "fragment" ? -1 : 1;
    return a.seq - b.seq;
  });

  // Open assistant message being accumulated from consecutive stdout fragments.
  let buffer: { text: string; at: string; seq: number } | null = null;

  const flush = () => {
    if (!buffer) return;
    // Trailing whitespace from delta boundaries would render as blank lines.
    const text = buffer.text.replace(/\s+$/, "");
    if (text.length > 0) {
      entries.push({
        kind: "assistant",
        id: `assistant-${buffer.seq}`,
        text,
        at: buffer.at,
      });
    }
    buffer = null;
  };

  for (const item of timeline) {
    if (item.type === "interaction") {
      flush();
      entries.push({
        kind: "interaction",
        id: `ix-${item.value.interactionId}`,
        interaction: item.value,
      });
      continue;
    }

    const frag = item.value;
    switch (frag.stream) {
      case "stdout":
        // Accumulate — this is the fragment-merging that makes prose readable.
        if (buffer) {
          buffer.text += frag.fragment;
        } else {
          buffer = { text: frag.fragment, at: frag.emittedAt, seq: frag.sequence };
        }
        break;
      case "tool": {
        flush();
        const tool = parseToolFragment(frag.fragment);
        if (tool) {
          entries.push({ kind: "tool", id: `tool-${frag.sequence}`, tool });
        } else {
          // Truncated or malformed payload — show the raw text rather than
          // silently dropping evidence that a tool ran.
          entries.push({
            kind: "system",
            id: `tool-raw-${frag.sequence}`,
            text: frag.fragment,
          });
        }
        break;
      }
      case "stderr":
        flush();
        entries.push({
          kind: "warning",
          id: `warn-${frag.sequence}`,
          text: frag.fragment,
        });
        break;
      case "meta":
        flush();
        entries.push({
          kind: "system",
          id: `meta-${frag.sequence}`,
          text: frag.fragment,
        });
        break;
    }
  }
  flush();

  return entries;
}
