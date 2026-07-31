---
title: "Terminal bash streaming"
---

## Changes

**Protocol types** ([protocol.ts](../src/lib/pi/protocol.ts)):
- Added `bash_execution_update` event type with `id` and `delta` fields for streaming bash output
- Updated `bash` command type to include optional `excludeFromContext` field
- Expanded `AssistantMessageEvent` with full lifecycle types (`*_start`, `*_delta`, `*_end`, `done`)
- Added `toolName` and `args` to `tool_execution_update` and `tool_execution_end` for richer agent-bridge context
- Clarified `BashResult.output` as the final/possibly-truncated snapshot vs the event stream

**RPC client** ([client.ts](../src/lib/pi/client.ts)):
- Fixed `request()` to preserve caller-supplied `id` instead of overwriting — pi echoes this on `bash_execution_update`, so overwriting broke correlation
- Updated `MockTransport` to emit `bash_execution_update` events before the final response, matching real pi behavior

**Classic terminal** ([terminal-shell.ts](../src/lib/terminal-shell.ts)):
- Subscribe to `bash_execution_update` events matching the command's `id`
- Write each `delta` as it arrives; track `streamed` byte count
- On response, only write the tail beyond what the events already delivered (truncated output can be shorter than the stream, leaving nothing to append)

**Block terminal** ([terminal-block-shell.ts](../src/lib/terminal-block-shell.ts)):
- Same streaming approach: `appendOutput(blockId, delta)` on each `bash_execution_update`
- Final response fills the remaining gap (if any)

## Why

Before this change, bash output appeared only when the command finished — a 30-second `npm install` looked frozen. Pi's RPC mode has streamed `bash_execution_update` events since its introduction, but the desktop client never wired them up. The protocol comment "output does NOT stream as events" was a misreading of the docs — streaming exists, but was never used.

## Testing

**Browser dev (`pnpm dev`)**: MockTransport now emits 4 incremental events before the response, so the de-duplication path is exercised without needing a real pi binary.

**Tauri dev (`pnpm tauri:dev`)**: Open the terminal drawer (⌘J), run a slow command (`ping -n 10 127.0.0.1` on Windows / `sleep 3 && echo done` on macOS/Linux). Output appears line-by-line as it's produced, not all at once at the end.

**Blocks mode**: Same test, output streams into the card while `status: "running"`.
