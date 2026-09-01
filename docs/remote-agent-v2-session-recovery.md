# RAV2 session recovery (V2.2)

How a desktop attaches to a detached task, replays what it missed, and sends input
exactly once. Builds on the journal and `status.json` defined in
[remote-agent-v2-supervisor-protocol.md](remote-agent-v2-supervisor-protocol.md).

Capability name: **`attach-v1`**.

The replay semantics here are not invented. `crates/pi-remote-control/src/event_hub.rs`
already implements monotonic sequences, an `after` cursor, and `snapshot-required`
when a cursor falls outside the retained window, with g004/g005 covering it. That is
the spec; this is the same contract reimplemented in the launcher's JS over a file
instead of an in-memory ring. Likewise the `(key, fingerprint, expiry)` idempotency
triple comes from `task_manager.rs`.

## The four connection states live here, not in `status.json`

`status.json` reports **process** state — `starting` / `running` / `stopping` /
`exited` — because that is all a launcher standing next to pi can observe. The four
states the desktop cares about are derived:

| Desktop state | Derivation |
| --- | --- |
| `running` | attach channel open, `--status` says `running` |
| `lost` | the local transport gave up. Measured at **24.2s**, TCP-level — not the ~45s `ServerAliveInterval × CountMax` implies. Remote state is **not inferable**: a partitioned pi stays alive for up to ~2h. |
| `exited` | `--status` reports `exited`, or an attach ended with `reason: "taskExited"` |
| `orphaned` | `--status` reports `running` for a task the desktop no longer owns |

**`lost` and `orphaned` must stay distinct.** V1 collapsed them into one "unknown"
and then guessed — defect D2. Guessing is wrong for up to two hours.

## `--attach <base64Payload>`

The long-lived channel. Read-only by construction: it takes no lock, writes nothing,
and any number of clients may attach to one task at once.

```json
{"protocolVersion":1,"remoteTaskId":"task-0001","after":41,"follow":true}
```

- `after` — emit records with `sequence > after`. `null` or absent starts from the
  oldest record still retained.
- `follow` — keep tailing after catching up. `false` replays and exits, which is what
  a bounded catch-up wants.

Every line of stdout is one JSON object. A failure is the same single
`{"ok":false,"errorCode":…}` line every other task mode uses, so the desktop tells
success from failure by whether the first line has a `type`.

### Frames

```json
{"type":"attached","remoteTaskId":"task-0001","state":"running","after":41,"baseSequence":1,"nextSequence":42,"snapshotRequired":false,"pid":40213,"supervisorPid":40199}
{"type":"event","sequence":42,"ts":1788172490461,"stream":"stdout","data":"{\"type\":\"message_end\",…}"}
{"type":"gap","fromSequence":43,"toSequence":900}
{"type":"detached","reason":"taskExited","exitCode":0,"nextSequence":901}
```

- **`attached`** is always first and always present on success.
- **`event`** carries the journal record verbatim plus its `sequence`. `stream` is
  `stdout` | `stderr` | `control`; a control record keeps its `event` field. `data` is
  the raw pi line, unparsed — **streaming is not guaranteed**, so a consumer that
  reads `text_delta` alone silently loses whole turns and must reconstruct from
  `message_end` too.
- **`gap`** means records were evicted between `fromSequence` and `toSequence` while
  this attach was behind. The desktop must treat its transcript as incomplete from
  that point. An eviction that leaves **no** segments at all is not a gap — the task
  was reaped, and attach reports `taskGone` instead. Without that distinction the
  eviction branch re-opens a path that can never exist and emits one `gap` per poll
  forever.
- **`detached`** is last. `reason` is `taskExited` (terminal and fully drained),
  `caughtUp` (`follow: false`), or `taskGone` (the directory was reaped underneath).

Exit is always 0. The frames carry the outcome, so a nonzero exit means the transport
failed, never the task.

### snapshotRequired

Computed once, at attach, using event_hub's exact predicate: the cursor is outside
the window iff `after + 1 < baseSequence` — the record immediately after the cursor
has been evicted, so the desktop cannot know what it missed.

It is reported **in the `attached` frame** rather than as its own event. event_hub
emits a separate control event because its callers poll; an attach has a handshake,
and one place to look beats an ordering rule. Streaming then continues from
`baseSequence`, so a stale cursor still recovers a live view — it just has to discard
its transcript first.

Like event_hub's, this consumes no sequence space and mutates nothing, so the same
stale cursor gets the same answer on every retry.

### Terminal detection

`--attach` checks the status **only after a full drain**, and the supervisor appends
its `exited` record *before* committing the terminal status. So a terminal status
guarantees that record is already on disk and already emitted. Reading
`journal.nextSequence` instead would race its one-second throttle and could detach a
record early.

### Tailing

The supervisor is the journal's only writer, so a reader needs no coordination. Attach
holds `(segment, byteOffset, sequence)` and polls every **100ms**: it emits only
complete LF-terminated lines, because a partial tail is a write in progress, and
crosses into the next segment only after the current one is fully drained. That poll
is where the "journal adds a hop, so latency is bounded but nonzero" cost lands.

Starting mid-segment costs one scan of that segment to convert `after` into a byte
offset — bounded by `SEGMENT_MAX_BYTES`, paid once per attach.

## `--send <remoteTaskId>` and exactly-once input

Attach is read-only, so **`--send` is the only writer**. That is deliberate: the
`stdin.lock` mkdir lock is then held for one send rather than for a whole session, so
a second desktop can take over without waiting for the first to disconnect, and a
dead attach can never leave a stuck lock.

The cost is one SSH round trip per message. That is human-paced work against a system
whose disconnect detection is already 24s, so it is the right trade.

Idempotency is opt-in, through a key on stdin's first line:

```
{"idempotencyKey":"k-7f3a91c2","payload":"{\"type\":\"prompt\",\"message\":\"…\"}\n"}
```

Without a key, stdin is forwarded verbatim as in V2.1 — unchanged, so nothing that
already works has to adopt this.

With a key, the outcome is recorded in `stdin.sends.json`, written under the same
lock that guards the FIFO, so the writer is single by construction:

| Case | Result |
| --- | --- |
| key unseen | forward, record, `{"ok":true,"duplicate":false,…}` |
| key seen, same fingerprint | **do not forward**, `{"ok":true,"duplicate":true,…}` |
| key seen, different fingerprint | `sendIdempotencyConflict` — the same key must not mean two different messages |

`fingerprint` is a SHA-256 prefix of the payload bytes. Records expire after **24h**
and are bounded to **256 entries**, pruned oldest-first on each send. Both numbers
come from `task_manager.rs`, scaled down: a per-task file needs nothing like its 4096
global entries.

### Why a key at all

A disconnect at 24s tells the desktop nothing about whether its last prompt landed —
the write may have completed and the reply may already be in the journal. Retrying
blind duplicates a turn; not retrying loses one. The key makes the retry safe, and it
is the only reason `--send` needs to be more than a pipe.

## Reconnect

1. `--status <id>`. `exited` ends it; `running` means reattach.
2. `--attach` with `after` = the highest sequence already applied.
3. If `snapshotRequired`, discard the transcript and rebuild from the replay.
4. If the last send is unconfirmed, repeat it with the **same** `idempotencyKey`.

Backoff is tuned against the measured **24.2s** detection window, not against
`ServerAliveInterval × CountMax`: TCP-level failure fires first, so a reconnect
schedule derived from the keepalive arithmetic waits about twice as long as it needs
to.

## Identity

Event identity is `(taskId, generation, targetId, remoteTaskId, sequence)`.

`remoteTaskId` is **orthogonal to `generation`**: generation is a local per-spawn
counter, and every reattach opens a new ssh child — a new generation against the
*same* remote task. Filtering replayed events by generation drops all of them.

**One `remoteTaskId` = one remote pi process for its entire life.** So a sequence gap
is always eviction or disconnect, never a new process. Continuing after pi dies means
minting a new id with `previousTaskId` set.

## Error codes

Adds to the V2.1 table:

| Code | Meaning |
| --- | --- |
| `attachPayloadInvalid` | Attach payload failed shape validation. |
| `sendIdempotencyConflict` | Key reused with a different payload. |
| `sendPayloadInvalid` | Keyed send envelope failed shape validation. |

## Verification

`pnpm test:detached-tasks` — 29 tests, 18 of which run anywhere. Attach is a pure
reader, so the cursor, snapshot-window, segment-boundary, gap and reap rules are all
tested against **crafted journals with no supervisor and no pi**, which is what makes
them platform-independent. `node scripts/run-remote-supervisor-stage0.mjs` runs all 29
on a real host, including live tailing and keyed sends against a running task.

Desktop-side decoding is `src/lib/pi/remote-attach.ts`, covered by
`tests/backend/remote-attach.test.ts`: frame validation, forward-only cursor
movement, snapshot and gap resets, and the rule that only `taskExited` means pi is
gone.

## Not in V2.2

No multi-client *writing* to one task — several readers are fine, one writer at a
time by lock. No collaborative editing, no push without an SSH channel. Those need a
real server and are V3.

The desktop is not wired yet: `ssh_attach_spec` and the task-mode specs exist with
tests but no Tauri command calls them, and `pi_bridge` still routes `pi_send` to the
ssh child's stdin. That wiring is the next change — it touches the locked command
inventory and the send path, so it is kept separate from the protocol it depends on.

## Desktop wiring (landed)

The protocol above is now reachable from the app. Three commands and one split:

- **`remote_task_ensure`** mints or reattaches a task. One entry point, three cases: no id ⇒ mint and start; id alive ⇒ reuse (a reattach); id dead ⇒ mint a new one and report `previousTaskId`. Kept out of `pi_start` because it costs two SSH round trips (~2.5s measured) and `pi_start` is synchronous while holding the process runtime's mutex.
- **`pi_start` forks on lifecycle.** Detached spawns read-only `--attach`; attached spawns `--run`. Everything downstream is unchanged — one child, stdout is lines, exit ends the channel — except that the lines are frames and *the channel ending no longer means pi died*.
- **`pi_send` is async and forks too.** Detached routes to `--send` with a per-message idempotency key; local and attached-remote still write the child's stdin without awaiting, so nothing existing got slower.
- **`remote_task_status` / `remote_task_stop` / `remote_task_reap`** are separate from `pi_stop`, which still means *disconnect*. "I am done looking at this" and "stop working" are different intents, and conflating them would make closing a window kill remote work — the opposite of why detached mode exists.

### The idempotency key is minted per message, not per attempt

A transport-level retry of one send must reuse its key, because a disconnect leaves it unknown whether the write landed. A caller deciding to send again is a *different* message and gets a new key. Format `k-<random>-<counter>`; the random prefix matters because a bare counter collides across desktop restarts against a task that outlived one, and the launcher treats a repeated key with a different payload as a conflict rather than a retry.

### Connection state is derived on the desktop

`src/lib/pi/remote-connection-state.ts`. A channel closing **without a detach frame** is `lost`: the launcher always announces a deliberate end, so silence means the transport died mid-stream. `caughtUp` is also `lost`, because it closed the channel deliberately while saying nothing about the task.

`lost` is the only state with no answer in it, and its one exit is asking the host — which is what the badge's Check action does. `orphaned` deliberately carries no warning colour: a task running with nothing attached is normal and recoverable. And a stop is still offered in `lost`, because the task may well be alive and refusing to try would leave a user with work they cannot stop.

### Lifecycle is a per-profile choice, applied to new conversations

`RemoteAgentSettings` offers it as two labelled choices rather than a switch — a switch would need a name for the *off* state, and these are two execution models, not a feature being enabled.

Changing it on an existing profile **does not migrate open conversations**: the binding is persisted per conversation, so they keep the mode they started with until they reconnect. The form says so. Retroactively moving running work nobody asked to move would be worse than the inconsistency.

An omitted lifecycle on save **keeps what the profile had** rather than defaulting — a caller round-tripping a profile without touching the field must not silently downgrade it.

### `--reap` runs on target switch

Opportunistic, deliberately not on a timer: acceptance showed orphans need a real network partition, so it is a cold path and a resident reaper would be machinery for an event that almost never fires. Switching to a host is the natural moment — stale task directories from a previous session are most likely and least in the way there. Fire-and-forget, because housekeeping must never be what stops someone connecting.
