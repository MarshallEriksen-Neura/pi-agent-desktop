---
title: "Subagents: follow a background run from its own row in the conversation"
---

## Problem

Launching a subagent produced a card that reported success within seconds while
the actual worker ran for minutes. There was no way to see what it was doing.

The installed producer is `pi-subagents`, not the reference extension the deck
was written against. Its background mode returns the instant it forks the
worker:

```js
details: { mode: "workflow", runId, asyncId, asyncDir, results: [] }
```

`results[]` is **empty**, so the deck fell through to its degraded single-card
path; then `tool_execution_end` fired immediately — the run is detached by
design — and settled that card to `done`. The next `agent_start` cleared it. The
worker was still running the whole time.

No progress for such a run arrives over the pi RPC stream at all: the
extension's `pi.events` bus is in-process and cannot reach this app.

## Where the progress comes from

`<asyncDir>/status.json` is rewritten every few seconds with the full live
picture, and the extension's docs point companion UIs at exactly these artifacts
rather than at scraped output.

- **`lib/pi/async-runs.ts`** parses and polls it. Every field is feature-detected
  and a torn or unreadable read yields `null`, keeping the last good snapshot
  instead of blanking the view. Polling backs off while the window is hidden,
  stops on a terminal state, and gives up on a run whose file has stopped
  advancing for 15 minutes — without concluding that run failed, which the
  producer's docs explicitly warn against inferring.
- **`lib/pi/subagents.ts`** treats a payload carrying `asyncDir` with an empty
  `results[]` as detached: it starts file polling instead of reading the call as
  a finished run, and the end-of-call settle now skips such cards. Snapshots are
  kept per `toolCallId` even after `clearFinished()` drops the card, so a
  subagent further up the transcript still opens.

## Three bugs this also fixes

**The bridge listened to the wrong pi process.** Every conversation runs its own
pi process, keyed by task id, but the store called `getPiClient()` with no
argument — which resolves to `DEFAULT_TASK_ID`, a process no conversation uses.
No subagent event ever arrived, so no card was ever created and the transcript
row had nothing to open. It now binds like `agent-bridge` does, to the active
task and to each new one on switch, keeping earlier bindings so a subagent
launched in a background conversation stays tracked. Cards are keyed by
`toolCallId`, so the shared store cannot leak between conversations.

**Management calls became phantom subagents.** `subagent` is one tool for two
jobs: `action: "list" | "status" | "stop"` returns
`details: { mode: "management", results: [] }`, which the degraded path turned
into a card named "subagent" with no task. Asking which agents exist left a blank
subagent in the transcript. Those calls are now ignored.

**Synchronous runs had an empty timeline and no result.** The card mapping read
`result.messages`, which is the *reference extension's* shape — `pi-subagents`
has no such field. A finished worker reports `toolCalls: [{ text, expandedText }]`
and `finalOutput`. Both shapes are now feature-detected, so a synchronous run
shows its steps and its answer instead of an empty panel.

**Foreground runs arrived as one lump at the end.** `results[].toolCalls` is a
bounded tail of pre-rendered strings, published as the result takes shape — it
says nothing about what is running *now*, so a foreground subagent read as batch
output even though events were streaming the whole time.

The producer streams a purpose-built live channel that was being ignored:
`details.progress[]`, its `AgentProgress`, on every step of a foreground run.
It carries `currentTool` / `currentToolArgs` / `currentToolStartedAt`,
`recentTools`, `recentOutput`, `toolCount`, `turnCount`, token splits, and
duration.

Those `recentTools` / `recentOutput` are the *same shape* the async status file
writes, so `readSyncProgress()` maps a foreground run onto the identical model
the panel already renders. One rendering path, two transports — the UI never
learns which kind of run it is showing. `currentTool` is preferred over the tail
everywhere it exists, including on the transcript row, because `recentTools` only
holds calls that have already returned: during a slow call its last entry is the
*previous* tool, which is the difference between "it just read a file" and "it
has been grepping for 40 seconds". The in-flight call also shows its own elapsed
time, so a stuck tool is visible before the whole run looks stalled.

One asymmetry the producer forces: the closing result drops `progress` unless the
call asked for it, so the last streamed snapshot would sit at "running" forever.
The tool call ending settles it, and the closing payload — the only one carrying
saved output paths — is merged in for its artifacts.

## Where it shows up

**The subagent's own tool row in the conversation is the control.** No separate
deck above the transcript and no extra button beneath the row: the row opens the
inspector, reports the worker's current tool in its own detail slot while it
runs, shows elapsed time, and takes an accent edge while its inspector is the
open one — so it is always clear which row the panel belongs to. Clicking it
again closes the panel.

**The inspector is a docked column, not an overlay.** The chat rail is already
the rightmost column, so a floating panel sat on top of the very conversation
that spawned the subagent, and its backdrop blocked replying while you watched.
It is now a peer of the sidebar and the rail — same spring, same material,
resizable, persistent — and opens to the *left* of the chat so the conversation
stays visible and answerable. It yields width to the rail rather than the other
way round, and follows the chat: absent in zen mode, present in work mode.

Reading order answers the question that made someone open it, then works
outward: current action (with a stall notice attached to it, not filed in a
footer) → task → sibling steps → tool feed → result → files produced →
tokens/cost/turns last. When a run ends, the same panel shows its result in
place; nothing has to be reopened. Switching between siblings swaps the body
while the frame holds still.

Because the panel is not modal, `Esc` no longer claims the key globally: while
the caret is in a field it belongs to whatever is being typed into, so the
composer's slash menu keeps working with the inspector open.

Synchronous runs and the local `agents` demo use the same panel, falling back to
the card's own timeline. The demo's cards now share one synthetic call prefix so
all three appear as siblings, and it opens the panel itself since it has no
transcript row to click.

## Testing

The parser and the store's mapping were exercised against a real 44 KB
`status.json` from a completed 6-minute `scout` run, plus synthesized running,
multi-step, failed, and no-steps-yet snapshots. Poller lifecycle covers terminal
stop, stale cutoff, cancellation, and unreadable files. Payload routing was
checked across seven shapes to confirm the reference extension's synchronous
path is unchanged — including a finished synchronous run, which carries
`asyncDir` too and must not be mistaken for a detached one. The three-column
width budget was checked from 1024 to 1920 px: the chat never drops below its
280 px floor.

Not covered: browser dev mode has no real filesystem, so `MockTransport`'s
`subagent` keyword still only exercises the synchronous path. At 1024 px with
both the sidebar and the inspector open the editor is squeezed below its own
floor — the pre-existing "the editor is the one that gives" policy, now reachable
at one more window size.
