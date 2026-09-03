# RAV2 supervisor protocol (V2.1)

Wire contract for detached remote tasks. Every bound here comes from a measurement
in [remote-agent-v1-acceptance.md](remote-agent-v1-acceptance.md); none is an estimate.

Capability name: **`detached-tasks-v1`**. All modes below ship together — a host
either has the whole set or none of it, so a desktop feature-detects one name.

## Why a per-task supervisor, not a daemon and not a bare redirect

Acceptance showed a crashed desktop — even SIGKILL — does not orphan a remote pi;
only a real network partition does, and that leaves it alive for up to ~2h. Orphans
are therefore a cold path, so reaping belongs on the next launcher invocation
(the pattern provider-sync already uses) rather than in a resident service.

A bare `pi >> events.jsonl &` was rejected: the journal must tag each line with its
stream, frame it as JSON, and rotate on a byte cap. All three need a writer that
reads pi's pipes. So each task gets **one supervisor process that lives exactly as
long as its task** — not a daemon, since nothing is always-on and nothing is shared.

## Task directory

`~/.pi-desktop/tasks/<remoteTaskId>/`, mode 0700, created with the same primitives
as provider-sync: temp+rename+fsync, symlink rejection on every path, mode 0600.

| Entry | Role |
| --- | --- |
| `events-<baseSequence>.jsonl` | Journal segments. Append-only. Highest base is live. |
| `status.json` | Atomically replaced. The only mutable state. |
| `stdin.pipe` | FIFO. Supervisor reads; a writer takes `stdin.lock` first. |
| `stdin.lock/` | mkdir lock directory + `owner.json`, exactly as provider-sync. |
| `pi.pid` | pi's pid, because **pi rewrites its argv to a bare `pi`** and no reaper can find it by command line. |
| `supervisor.pid` | The supervisor's pid, for the same reason. |

### `remoteTaskId`

`^[a-z0-9][a-z0-9-]{7,63}$`. Minted by the desktop, never by the launcher.

**One `remoteTaskId` = one remote pi process for its entire life.** To continue
after pi dies, mint a new id and record `previousTaskId` in the new task's
`status.json`. This single rule is what removes the "is a sequence gap a disconnect
or a new process?" ambiguity — a gap is always a disconnect.

`remoteTaskId` is **orthogonal to `generation`**: generation is a local per-spawn
counter in `pi_bridge.rs`, and attaching creates a new local ssh child (new
generation) against the *same* remote task. Event identity is
`(taskId, generation, targetId, remoteTaskId, sequence)`.

## Journal

One JSON object per line, LF-delimited, UTF-8.

```json
{"ts":1788172490461,"stream":"stdout","data":"{\"type\":\"message_end\",…}"}
{"ts":1788172490470,"stream":"control","event":"exited","exitCode":0}
```

- `stream` is `stdout` | `stderr` | `control`. stderr was **0 bytes in every
  acceptance scenario** and pi's protocol errors arrive on stdout, so one ordered
  journal with a stream tag beats two files.
- `data` is the raw line, unparsed. **Streaming is not guaranteed**: the same prompt
  sometimes arrives as `text_delta` and sometimes only as finished text in
  `message_end`. A consumer reading deltas alone silently loses whole turns, so the
  journal stores raw JSONL and reconstruction is the reader's job.
- `control` records are the launcher's own: `started`, `stop_requested`, `exited`.
  There is deliberately no `rotated` record — the segment filenames already carry
  that fact, and no `overflow` record, because the only thing that stops the
  journal is being unable to append to it.

### Single writer

**The supervisor is the only writer of `status.json` and the journal while it
lives.** That is what keeps sequence bookkeeping lock-free. Every other mode may
write only after proving the recorded `supervisorPid` is dead, at which point there
is no one to race. `--stop` therefore signals and then *reads*; it does not append
its own record.

### Sequence

`sequence` is **not written into the record**. It is the task-wide 1-based line
number: for line *k* (1-based) of the segment whose base is *B*, `sequence = B + k - 1`.
`status.json.journal.nextSequence` is authoritative and monotonic for the task's
whole life.

This is why segments are named by base rather than rotated through a fixed
`events.jsonl`: a reader can locate any sequence from the filenames alone, and no
rename ever races an append. Bases are zero-padded to 12 digits so lexicographic
order equals numeric order.

### Rotation and caps

Caps are **byte-based, never per-line** — an 8513-char JSONL line is legitimate,
and rotation must never split one, or replay resumes mid-object.

| Bound | Value | Why |
| --- | --- | --- |
| `MAX_EVENT_BYTES` | 1 MiB | Longest observed line was 8513 chars; this bounds a runaway one without truncating anything real. Over-long lines are stored truncated with `truncated: true`. |
| `SEGMENT_MAX_BYTES` | 16 MiB | Rotation granularity only, not a task limit. A segment closes at the first line boundary at or past this. |
| `TASK_MAX_BYTES` | 192 MiB | ~2h at the measured 12.8 KB/s is ~90 MB; this clears the orphan ceiling with headroom. Oldest segments are deleted first, and `journal.baseSequence` then reports the oldest line still present. |
| `IDLE_TTL_MS` | 6h | Must exceed the ~2h orphan ceiling by a margin so a live-but-quiet task is never reaped. |
| `MAX_LIVE_TASKS` | 8 | Per **host**, not per profile — the launcher has no profile concept. A desktop may cap more tightly per profile. |
| `MAX_TOTAL_TASK_BYTES` | 512 MiB | Across all task dirs. Terminal tasks are deleted oldest-first. |

Hitting `TASK_MAX_BYTES` never kills a task: it drops the oldest segment. Only a
write failure appends `overflow` and stops pi.

## `status.json`

```json
{
  "statusVersion": 1,
  "remoteTaskId": "t-7f3a91c2d0e4",
  "previousTaskId": null,
  "state": "running",
  "pid": 40213,
  "supervisorPid": 40199,
  "startedAt": 1788172490400,
  "updatedAt": 1788172490461,
  "exitCode": null,
  "exitSignal": null,
  "stopRequestedAt": null,
  "stopConfirmedAt": null,
  "cwd": "/home/u/project",
  "piExecutable": "pi",
  "resumePath": null,
  "journal": {
    "liveSegment": "events-000000000001.jsonl",
    "baseSequence": 1,
    "liveBaseSequence": 1,
    "nextSequence": 42,
    "totalBytes": 8613
  }
}
```

`state` is one of `starting` | `running` | `stopping` | `exited`. These are
**process** states, observed from the same host as pi.

Two fields appear only when they apply. `stale: true` marks a death nobody
witnessed — written by whichever mode discovered that the supervisor was gone, and
never cleared, so a repaired record cannot later read as a clean exit. `errorCode` /
`error` appear when the supervisor itself failed to get pi running; their absence on
a terminal record means pi really did run.

`journal.nextSequence` and `totalBytes` are written at most once a second while a
task streams, so they can lag the journal by that much. The journal is the record of
truth; `status.json` is a summary of it.

The four *connection* states in the design — `running` / `lost` / `exited` /
`orphaned` — are **desktop-side** and are deliberately absent here. `lost` and
`orphaned` describe the channel, which a launcher running next to pi cannot see.
The desktop derives them: `lost` is its own transport giving up (measured at
**24.2s**, TCP-level, not the ~45s `ServerAliveInterval × CountMax` implies), and
`orphaned` is `--status` reporting `running` for a task the desktop no longer owns.
Collapsing `lost` and `orphaned` into one "unknown" and then guessing was V1's
defect D2; they must stay distinct.

## Stop is two events, 17× apart

`stopRequestedAt` / `stopConfirmedAt` exist because acceptance measured pi
acknowledging `abort` in-band in **204ms** while the remote process only
disappeared **3.4s** after channel close.

Record both. The ack proves the model stopped generating; process death proves the
session file was released. Reporting only the fast one calls a task stopped while
its session file is still held; only the slow one makes cancellation feel broken.

## Modes

Every mode writes exactly one JSON line to stdout and exits 0 — including on
failure, which carries `{"ok":false,"errorCode":…}`. **A status check must fail
loud, never fail empty**: a probe that swallows its error reports "no remote
processes", which is indistinguishable from a real clean state.

## Orthogonal PI management control plane (launcher revision 5)

Package and skill management is intentionally **not** a supervisor mode and never enters a
task's JSONL stream. The desktop starts a separate, short-lived SSH invocation of
`pi-desktop-launcher --manage`, sends one protocol-v1 JSON envelope on stdin, reads one
bounded JSON reply, and closes it. The renderer can provide only the target identity, scope,
package/skill identifier, and semantic operation; SSH argv, launcher path, remote `HOME`,
cwd selection, environment, shell, and CLI argv remain backend/launcher-owned.

The four capabilities are independent: `pi-packages-read-v1`,
`pi-packages-mutate-v1`, `pi-skills-read-v1`, and `pi-skills-mutate-v1`. Missing mutation
support produces a read-only UI rather than disabling inspection. A launcher without
capability discovery is treated as old and upgradeable, not as evidence that the host is
damaged. Global scope resolves to remote `$HOME/.pi/agent`; project scope resolves to the
binding's `remoteCwd/.pi`. There is no local-filesystem fallback.

The launcher accepts only `inspect`, `readSkillSource`, `browseSkillSource`,
`mutatePackage`, and `mutateSkill`, with exact-key request validation. Source reads use
opaque SHA-256 references minted by `inspect`. Mutation compares an opaque `stateToken`
inside a host-wide mkdir lock, runs only launcher-constructed PI/Skills CLI arguments, and
always returns a fresh authoritative snapshot after the command. Nonzero CLI exit can still
change state; clients therefore apply that snapshot and mark affected tasks dirty before
showing the command error. Skill move remains explicitly non-atomic and reports
`halfDone: true` when destination install succeeded but source removal failed.

Bounds: 64 KiB request; 30 seconds for inspect/read, 120 seconds for browsing, 300 seconds
for mutation; 2 MiB response; 64 KiB diagnostics; 256 KiB per `SKILL.md`; 512 KiB each for
settings/package lock; 512 packages and 2,048 skills. Settings snapshots expose only
`packages`, package locks expose only versions, and diagnostics redact common credentials.
CLI timeout terminates the process group with TERM then KILL. Live mutation locks are never
stolen; stale locks are reclaimed under a separate reclaim lock by atomic quarantine rename.
`launcherRevision` is 5; `statusVersion` stays 1 because management does not change the
detached task schema.

`--capabilities` stays the first thing the script answers, before any node
discovery, so a desktop can still ask what a host supports when node is broken.

### `--start-detached <base64Payload>`

Payload extends the run payload with `remoteTaskId`:

```json
{"protocolVersion":1,"cwd":"/abs","piExecutable":"pi","resumePath":null,"remoteTaskId":"t-…"}
```

Creates the task dir, FIFO and `status.json` (`starting`), then spawns the
supervisor detached — Node's `detached: true`, which gives a new session without
depending on `setsid` being installed. Waits for the supervisor to report, then
prints `{"ok":true,"remoteTaskId":…,"pid":…,"supervisorPid":…,"startedAt":…,"stdinReady":…,"state":…,"exitCode":…}`.

**A pi that exits inside the start window still started.** Only the supervisor's own
`errorCode` in `status.json` means it never got off the ground; a fast clean exit
comes back `ok: true` with `state: "exited"`. Without that distinction a script whose
whole job is to run and exit would be reported as a launch failure.

Rejects an existing task id with `taskAlreadyRunning`, terminal or not, so a retried
start cannot produce two pi processes over one journal.

### `--supervise <base64Payload>` (internal)

Not advertised in `--capabilities` and not part of the desktop contract. This is
how the launcher re-enters itself as the detached supervisor: it is the same file
at the same absolute `launcherPath`, so no source has to be embedded or copied.
Refuses to run unless `PI_DESKTOP_SUPERVISOR=1` is set, which only
`--start-detached` sets.

The supervisor spawns pi with piped stdio, frames every line into the journal,
forwards FIFO input to pi's stdin, and on exit writes the terminal `status.json`
plus an `exited` control record.

**It does not forward SIGHUP.** A targeted inversion of run mode, which forwards
SIGTERM/SIGINT/SIGHUP to its pi child — that forwarding is exactly what makes an
attached task die with its channel, and exactly what a detached task must not do.
SIGTERM and SIGINT are still forwarded, because those mean a deliberate stop.

### `--status <remoteTaskId>`

Reads `status.json`, then **verifies the recorded pids are alive** and that pi's
parent is the recorded supervisor. Never trusts the file alone: a supervisor killed
with SIGKILL leaves `running` written. A live file describing a dead process is
reported as `exited` with `exitCode: null` and `stale: true`.

Omit the id to list every task (bounded, newest first).

### `--stop <remoteTaskId>`

Signals the supervisor with SIGTERM and then polls `status.json`, because the
supervisor owns both writes: it appends `stop_requested`, records
`stopRequestedAt`, forwards SIGTERM to pi, and writes the terminal record with
`stopConfirmedAt` and `exitCode` when pi actually dies. After 5s without
confirmation, `--stop` escalates to SIGKILL on pi and then the supervisor, and only
then — with no live writer left — repairs the record itself.

Idempotent: stopping a terminal task returns its recorded outcome rather than
signalling a pid the OS may have recycled.

### `--send <remoteTaskId>`

Takes the `stdin.lock` mkdir lock, writes stdin verbatim into the FIFO, releases.
Exists in V2.1 so the lock has one implementation shared by both ends — two desktops
attached to one task must not interleave halves of two JSONL lines into pi's stdin.
Refuses a task that is not `running` (`taskNotRunning`).

### `--reap`

Opportunistic housekeeping, safe to run at any time and expected to be called
alongside other invocations rather than on a timer.

1. For each task whose supervisor is gone: if the recorded pi pid is alive and has
   been reparented away from that supervisor, SIGTERM then SIGKILL it, and mark the
   task `exited` with `stale: true`.
2. Delete task directories with no readable `status.json` — nothing can attach to one.
3. Delete terminal task dirs past `IDLE_TTL_MS`.
4. Delete terminal task dirs oldest-first while total bytes exceed
   `MAX_TOTAL_TASK_BYTES`.

Never touches a task whose supervisor is alive.

**Only pids the launcher recorded are ever signalled.** A `pgrep -x pi` sweep was
considered and rejected: pi rewrites its argv to a bare `pi`, so a pi the user
started by hand is indistinguishable from an orphan, and killing one would be a coin
flip on someone else's session. Discovery for any future sweep must also split by
`comm` (`node` for the launcher, `pi` for pi) rather than filter on
`PI_DESKTOP_LAUNCHER_MODE`, which pi **inherits**.

## Error codes

Stable strings; the desktop maps them to messages.

| Code | Meaning |
| --- | --- |
| `taskPayloadInvalid` | Payload failed shape validation. |
| `taskIdInvalid` | `remoteTaskId` failed its pattern. |
| `taskAlreadyRunning` | That id already has a directory, terminal or not. |
| `taskNotFound` | No directory for that id. |
| `taskNotRunning` | `--send` to a task that is not `running`. |
| `taskLimitReached` | `MAX_LIVE_TASKS` would be exceeded. |
| `taskSymlinkRejected` | A path in the task dir is a symlink. |
| `taskWriteFailed` | Could not write the journal or status, or `mkfifo` is unavailable. |
| `taskLockTimeout` | Could not take `stdin.lock`. |
| `supervisorNotInvokable` | `--supervise` called without `--start-detached` behind it. |
| `supervisorStartFailed` | Supervisor never reported at all. |
| `piStartFailed` | pi itself could not be spawned. |

## Verification

Core logic is JS in the launcher, so it runs locally: `pnpm test:detached-tasks`
(`node --test remote-launcher/test-detached-tasks.mjs`). This was the third reason
the launcher beat a Rust daemon — the other two being no cross-compile matrix and a
single-file install.
Management protocol coverage runs separately with `npm run test:remote-management`
(`node --test remote-launcher/test-management.mjs`). Its portable cases cover capability
revision, exact-key validation, sanitized inspect/source reads, reply bounds, and the
process-group wrapper. POSIX cases additionally exercise state conflicts, active/stale locks,
missing CLIs, nonzero command exits with authoritative post-state, and skill-move `halfDone`.


The suite splits by what a platform can represent. Status repair, stop bookkeeping,
reap policy, payload and id validation, and the task limit are pure file logic over
crafted task directories and run anywhere, Windows included. The eight tests that
start a real supervisor need FIFOs, `/proc` and POSIX signals, so they skip on
win32 — run them with `node scripts/run-remote-supervisor-stage0.mjs [--host alias]`,
which ships the launcher and the suite to a real host and runs all 20 there. That
stage is also the only place the **LF** form of the launcher is exercised: the
working tree is CRLF under `core.autocrlf`, and git stores LF.

Real-model scenarios extend the existing harness
(`node scripts/remote-agent-acceptance.mjs <scenario>`): after `--start-detached`,
kill the local ssh and confirm `--status` still reports `running`; after `--stop`,
confirm both `stopConfirmedAt` and `exitCode` are persisted.

## Not in V2.1

Attach, replay from a cursor, and send idempotency are V2.2 — this document defines
the journal and cursor semantics they build on, and nothing more. The Rust side
carries the argv policy and the binding field but has no Tauri command surface yet:
the first thing with a task to address is V2.2 attach, so wiring commands before
that would mean shipping a surface nothing exercises.
