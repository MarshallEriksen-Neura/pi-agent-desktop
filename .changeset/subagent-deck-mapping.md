---
title: "Subagent deck: derive cards from the producer's results[]"
---

## Problem

The subagent deck keyed one card per `toolCallId`. pi's reference subagent
extension (`examples/extensions/subagent/`, ships inside the pi package)
registers a single tool named `subagent` that runs 1..N workers per call —
`single`, `parallel` (`args.tasks[]`), and `chain` (`args.chain[]`). So a whole
parallel fan-out collapsed into one card, which is the one thing the deck exists
to show.

Downstream of that, the field mapping was wrong:

- `name` fell back to the literal string `"subagent"` in parallel/chain mode
  (there is no `args.agent`), and `task` fell back to `"…"`.
- The timeline pushed `JSON.stringify(partialResult).slice(0, 120)` as a "text"
  event. `partialResult` is a cumulative `{content, details}` object, not a text
  delta, so the timeline became the same truncated blob repeated.
- `progress += 0.12` capped at `0.9` was invented; nothing in the payload
  corresponds to it.
- The tool-name regex accepted `task`, `agent`, `spawn_agent`, and
  `dispatch_agent` — none of which any known producer registers.

## Change

Cards are now derived from `partialResult.details.results[]` and keyed
`${toolCallId}#${index}`, so N workers render as N cards. Per worker the deck
reads `agent`, `task`, `exitCode`, `messages[]`, `usage`, `model`,
`agentSource`, `stopReason`, `errorMessage`, `stderr`, and `step`.

- **Status** comes from the extension's `exitCode === -1` "still running"
  sentinel, then `stopReason`, then the exit code.
- **Timeline** is rebuilt from assistant `messages[]` on each update (the array
  is cumulative); event ids derive from the index so React keys stay stable.
- **Progress** is a real fraction only in chain mode, using the worker count
  declared in the tool args as the denominator — `results[]` grows as chain
  steps finish, so its length is the numerator, never the total. Parallel and
  single workers show elapsed wall-clock and an indeterminate sweep instead of a
  fabricated percentage.
- **Tokens, cost, and model** are surfaced on the card and in the detail sheet.
- **`agentSource: "project"`** gets a persistent warning badge: those agents are
  repo-controlled, and the extension only warns once via a confirm dialog.
- **Tool names** are now `["subagent"]` by default, overridable via
  `setSubagentTools()`.
- **`agent_start`** clears finished cards so the deck reflects the current turn.

Because the producer is a user-editable extension rather than protocol, every
field is feature-detected and an unrecognized payload degrades to a single card
using the tool's own text as its status line, instead of blanking or throwing.

## Testing

`MockTransport` gained a `subagent` keyword that emits the real payload shape —
three workers (one `project`-sourced, one failing), staggered tool steps,
`exitCode: -1` while running. Type `subagent` into the composer under
`pnpm dev` to exercise parsing, the fan-out, the error path, and the trust badge
without installing the extension.
