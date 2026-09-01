# V2.R — host-qualified workspace access

Prerequisite for V2.3 (read-only remote workspace). Written after counting the real call sites, not from estimate.

## Why this is not "add remote file browsing"

`ProjectCatalogPort.pick()` returns `string | null` from a native OS dialog. There is no version of that call that can enumerate a directory on an SSH host. So remote folder selection cannot be added to the existing surface — it forces a host-qualified reference either way. The choice is whether to introduce it deliberately now, or bolt a parallel `remotePick()` beside it later and keep both forever.

## Measured scope

| Fact | Number | Consequence |
| --- | --- | --- |
| `getPort("workspaceFs")` call sites | 13 — **11 inside `workspace.ts`** | The store is the chokepoint; the refactor is mostly one file |
| `getPort("projectCatalog")` call sites | 4 — **all inside `workspace.ts`** | Same chokepoint |
| Outliers outside the store | 2: `ImageViewer.tsx:27`, `async-runs.ts:454` | Must resolve through the same seam, or they silently read the wrong host |
| Components reading `useWorkspace` | **17** | **Decides the design: the ref must not travel through the UI** |

That last row is the whole argument. Threading a `WorkspaceRef` through props touches 17 components for zero benefit — within any one store snapshot, every path already belongs to exactly one target. The ref belongs to the *store*, not to the components.

## The defect this fixes

`switchExecutionTarget` (`sessions.ts:516`) resets sessions, task registry, and active id. It never touches `useWorkspace`. Switching a conversation to an SSH target therefore leaves the file tree showing the **local** project — same `root`, same `entries`, same `docs` — with nothing marking them as belonging to another host.

Today that is invisible: `openProject`/`pickProject` early-return under SSH, so the stale tree is merely inert. The moment V2.3 can read remote files, the same store would hold entries from two hosts keyed by bare path strings, and `docs["/src/main.rs"]` becomes ambiguous.

So the store's real missing field is not a path type. It is **which host its current contents came from**.

## Design

Three changes, each copying a pattern that already exists in this codebase.

### 1. `createWorkspaceFs(binding)` — mirrors `createPiProcess`

`BackendPorts` already carries both a default instance and a per-target factory:

```ts
piProcess: PiProcessPort;
createPiProcess: (taskId?, executionBinding?) => PiProcessPort;
```

Add the same pair. `workspaceFs` stays for the local/default case so nothing breaks; `createWorkspaceFs` resolves per binding:

```ts
workspaceFs: WorkspaceFsPort;                                  // unchanged
createWorkspaceFs: (binding?: ExecutionBinding) => WorkspaceFsPort;
```

Desktop composition resolves `kind: "local"` to `desktopWorkspaceFsPort` and `kind: "ssh"` to a remote implementation. Until V2.3 lands, the SSH branch returns a port whose every method rejects with a stable `remoteWorkspaceUnsupported`. **That is the type-level guarantee**: a remote binding cannot resolve to the local implementation, so a remote path can never reach `fs_bridge.rs`. The scattered `kind === "ssh"` early-returns become redundant rather than load-bearing.

Reuse note: `WorkspaceFsPort` needs no new methods and no signature change. Paths stay strings, because a port instance is already bound to one host — the host is carried by *which instance you hold*, which is exactly how `createPiProcess` carries its target.

### 2. The store records its target

```ts
interface WorkspaceStore {
  root: string | null;
  /** Which execution target `root`/`entries`/`docs` belong to. */
  targetId: string;      // "local" | `ssh:${profileId}`
  // …unchanged
}
```

The store resolves its port once from the active binding rather than calling `getPort("workspaceFs")` inline. `workspace.ts` already imports `useSessions` (line 8), so reading the active binding needs no new dependency.

`targetId` is also what lets the two outliers stay correct: both take a path and need the port for *whatever target that path belongs to*. A tiny shared helper — `workspaceFsFor(targetId)` — serves the store and both outliers, so there is one resolution path in the codebase, not three.

### 3. Repointing on target switch, without an import cycle

`switchExecutionTarget` must reset or repoint the workspace, but `sessions.ts` cannot import `workspace.ts`: the dependency already runs the other way and reversing it cycles.

The codebase has an established answer — `configureChatRecovery` and `configureSessionProjectRootResolver` are both single-assignment DI seams registered from `AppShell`. Add one more in the same shape:

```ts
configureWorkspaceTargetSwitch((binding: ExecutionBinding) => void);
```

`AppShell` registers it alongside the existing two. `switchExecutionTarget` calls it after it has committed the new binding. For an SSH target it clears `entries`/`docs`/`expanded` and sets `targetId`; for local it restores the local root. No cycle, no new architectural concept, and it fixes the stale-tree defect on its own.

## Staging

Two independently shippable steps. Step 1 is behaviour-preserving and can merge alone.

### V2.R-1 — resolution seam ✅ done (`36d5f09`)

Landed as planned, with two corrections worth recording.

**The factory takes a target id, not an `ExecutionBinding`.** Written the planned
way first, it forced callers holding only a path to fabricate a binding with a
zeroed revision and empty cwd — exactly the kind of invented value a later
implementation could act on. Choosing a filesystem needs only *which host*;
launching pi is what needs the whole binding.

**`readAsyncStatus` was already wrong, not just unqualified.** `asyncDir` comes
from a pi tool call, so under a remote target it is a remote path, and the
unconditional local read predates this refactor. Now resolves against the active
target with an optional override.

Also: `workspace.ts` no longer imports the session store at all — it reads its
own `targetId` — so the cycle risk that blocked the repoint is gone rather than
worked around.

1. `createWorkspaceFs` on `BackendPorts`; desktop + browser compositions supply it. SSH branch = fail-closed stub.
2. `workspaceFsFor(targetId)` helper; `workspace.ts`'s 11 call sites and the 2 outliers route through it.
3. `targetId` on the store, defaulting to `"local"`.
4. `configureWorkspaceTargetSwitch` seam; `switchExecutionTarget` calls it; `AppShell` registers it.
5. Update the two locked lists (`command-inventory.test.ts`, `check-backend-boundaries.mjs`) if any new command appears — Step 1 adds none.

Verification: existing suites stay at the 3 known baseline failures. New tests — a remote binding resolves to a port that refuses every call; switching to SSH clears the tree and sets `targetId`; switching back restores local.

### V2.R-2 — remote browsing (folds into V2.3) ✅ read half done

Only now does a real remote implementation appear, and only the read half:

- launcher gains a bounded `--workspace` mode: list directory, read file, stat. Fixed operations, bounded output, absolute paths only, symlink rejection — reusing the provider-sync path discipline verbatim.
- gate it behind `hasLauncherCapability(probe, "workspace-v1")`, the V2.0 handshake already shipped.
- `pick()` gains a sibling `browse(targetId)`: local keeps the native dialog, SSH returns a remote directory listing rendered by the existing file-tree component. **The tree component does not change** — it already renders `FsEntry[]` and is agnostic about where the entries came from.
- `remoteCwd` in `RemoteAgentSettings` becomes selectable via that listing instead of a hand-typed field, which is the thing that prompted this.

#### Wire contract

One base64 payload in, one JSON line out, exit 0 either way — the same envelope every other launcher mode uses.

```json
{"protocolVersion":1,"operation":"list"|"read"|"stat","path":"/abs","encoding":"utf8"|"base64"}
```

| Reply | Fields |
| --- | --- |
| `list` | `entries: [{name, path, isDir}]`, `truncated` |
| `read` | `encoding`, `content`, `bytes` |
| `stat` | `kind: "dir"｜"file"｜"other"`, `bytes`, `modifiedAt` |

Codes: `workspacePayloadInvalid`, `workspaceNotFound`, `workspaceNotADirectory`, `workspaceNotAFile`, `workspaceSymlinkRejected`, `workspaceTooLarge`, `workspacePermissionDenied`, `workspaceReadFailed`.

Bounds: path ≤4096 bytes, 2000 entries per listing, 2 MiB per file, 8 MiB per reply. The file cap bounds what is *read*; the reply cap bounds what is *sent*, because JSON-escaping utf8 can expand one byte into six.

#### Four things that came out differently

**`process.exit()` silently truncated every large reply.** Node's stdout to a pipe is async, `process.exit` discards whatever is still queued, and a POSIX pipe holds 64 KiB — so a 2 MiB read arrived as unterminated JSON, cut at 182720 bytes on a real host. Every one-shot reply now goes out through a synchronous, fully-drained `writeSync` loop. This was latent in the V2.1/V2.2 modes too; their replies were just small enough never to hit it.

**Not sandboxed to `remoteCwd`, deliberately.** The whole point is to *choose* that directory, so browsing has to go above it. This grants no authority the ssh user does not already have with `cat`, and a fake sandbox would be false comfort. Containment of the project tree stays the store's job.

**A symlink is a leaf, not a directory.** `lstat` everywhere, and reading or listing a link is refused with `workspaceSymlinkRejected` — but the link still appears in its parent's listing with `isDir: false`. Hiding it would conceal real content; calling it a directory would be a lie the tree acts on by trying to descend it.

**`stat` is not on `WorkspaceFsPort`, and no signature changed.** A listing already reports `isDir` per entry, which is everything a tree or a browse dialog needs, and `listDir` succeeding is itself proof that a hand-typed path is a directory. `root()` also still refuses on SSH: a remote root is the binding's `remoteCwd`, which the store already holds.

Landed: launcher `--workspace` + `workspace-v1`; Rust `ssh_workspace_spec` + the `remote_workspace_request` command; `createDesktopRemoteWorkspaceFsPort`, wired into desktop composition so an SSH target now resolves to a real read-half port.

Not yet done: `browse(targetId)` on `ProjectCatalogPort` and the `remoteCwd` picker UI. The port beneath them is in place and tested.

## V2.4 — hash-checked remote writes ✅ protocol done

Capability **`workspace-writes-v1`**, separate from `workspace-v1` so a host whose launcher predates writes still offers browsing with editing refused rather than attempted.

### Why a hash and not a lock

pi is editing the same tree, from the same host, at the same time. A blind write loses whichever change landed first with nothing to say it happened — and the window is not theoretical: the desktop reads a file, the user thinks, the agent edits it, the user saves.

`expectedHash` is **If-Match, not a checksum the caller computed**. The launcher mints the token on read; the desktop stores it opaquely and echoes it back. That distinction matters: a client-side hash over decoded text would disagree with the file's bytes for anything containing invalid UTF-8, turning one file in a hundred into a phantom conflict.

A lock was rejected: it would have to survive a 24s disconnect window, and a stale lock on a machine nobody is looking at is worse than a refused write.

### Operations

| Operation | `expectedHash` | Notes |
| --- | --- | --- |
| `write` | required — token, or `null` for "must not exist" | body on **stdin**, not argv |
| `create` | none | `O_EXCL`; `workspaceExists` if taken |
| `mkdir` | none | recursive; already-a-directory is success |
| `delete` | file: required · directory: none | directory must be **empty** |
| `rename` | none | refuses an occupied destination |

Codes added: `workspaceHashMismatch` (carries `currentHash`), `workspaceHashRequired`, `workspaceExists`, `workspaceDirectoryNotEmpty`, `workspaceWriteFailed`, `workspaceCrossDevice`.

### Three deliberate divergences from the local bridge

**A directory delete must be empty.** `fs_delete` removes a tree recursively. Doing that over ssh, on a machine the user is not looking at, needs a confirmation flow that does not exist yet — so the remote side refuses and says how many entries are in the way.

**A rename refuses an occupied destination.** POSIX `rename` silently replaces it, which is a lost file with no record it existed. (The local bridge has this bug; it is not "fixed" here, just not copied.)

**Omitting `expectedHash` on a write is refused, not defaulted.** `null` is an assertion — "I believe this path is free" — and absent means the caller has not decided. Guessing for it is how a concurrent create gets clobbered. All three states survive the wire: Rust models it as `Option<Option<String>>`, and the TS port uses `"expectedHash" in options` rather than a truthiness check.

Writes are temp+rename+fsync with the target's mode preserved, so a failure leaves the file either fully replaced or untouched — never half-written, which for a source file the agent is also reading is worse than either outcome. Symlinks are refused on every write path, including *into* a link's path, which would otherwise land the write outside the tree.

### Port shape

`HashedWorkspaceFsPort` is an **extension**, not a widening of `WorkspaceFsPort`: the local bridge has no hashes yet, and the store discovers the capability with `supportsHashedWrites(port)`. The base interface's mutators stay refused on SSH even now — a caller with no hash has to go through `readFileHashed` first rather than get a silent best-effort.

A lost update throws `RemoteWorkspaceConflictError` carrying `currentHash`, because the caller's response differs in kind from every other failure: not "it did not work" but "someone else got there first, and here is what they wrote".

Not yet done: the store's `saveFile`/`ensureDoc` still use the hashless methods, so the editor cannot yet save to a remote target. Threading the token through the store, and the reload-vs-overwrite conflict UI, land with the UI pass.

## What is deliberately not in scope

- No writes. `WorkspaceFsPort`'s mutating methods stay refused on SSH until V2.4, which owns hash-checked writes.
- No `WorkspaceRef` union threaded through the UI. Considered and rejected: 17 component touch points to encode something a single store field already determines.
- No change to `WorkspaceFsPort`'s signatures. If the port shape has to change, the design is wrong — the host belongs to the instance.
- No caching of remote listings beyond what the store already does per directory.

## Ordering

V2.R-1 and V2.1 (detached tasks + event journal) do not overlap: V2.1 is launcher JS plus Rust argv, V2.R-1 is frontend port wiring. They can run in parallel. V2.R-1 must land before V2.3 — doing V2.3 on bare string paths means doing it twice.

V2.1's own contract is [remote-agent-v2-supervisor-protocol.md](remote-agent-v2-supervisor-protocol.md): task layout, journal line format, the `status.json` state machine, every mode, and all bounds.

## The UI pass — two orthogonal axes ✅

The design the app now follows: **the right-hand picker chooses a machine, the top-left
picker chooses a directory on it.** `remoteCwd` left the settings page because bundling
the two made one config out of two independent choices, and made a profile look as
though it owned exactly one project.

| Axis | Control | Answers |
| --- | --- | --- |
| Where it runs | `ExecutionTargetPicker` (right) | which machine |
| What it works on | `ProjectSwitcher` (top-left) | which directory on that machine |

### What moved

- **`remoteCwd` is now on `ExecutionBinding`, not the profile.** `validate_binding`'s
  `remote_cwd == profile.remote_cwd` equality check is gone — a binding pointing
  somewhere the profile does not mention is normal, not drift. The revision check still
  guards what it always guarded: host configuration. A directory never was that. The
  path is still validated as absolute, because it becomes pi's cwd.
- **The profile keeps an optional browse starting point**, demoted to Advanced. Empty
  falls back to the remote `$HOME`, which preflight now reports — the cheapest fix for
  "the launcher only accepts absolute paths and the desktop cannot expand `$HOME`".
  Cached in `remote-home-cache.ts`, in memory only: `$HOME` is a fact about a live host,
  and a stale one on disk would send the browser somewhere that no longer exists.
- **Preflight split.** `cwd` is optional for `--preflight` and required for `--run`. With
  no cwd the launcher runs `pi --version` from `$HOME` and the workspace row comes back
  `skipped` rather than falsely green. A directory the user actually picks is validated
  when it is opened — the listing *is* the check, so no extra `stat` round trip.
- **`RecentProject` gained `targetId`.** The pair is the identity: `/srv/app` can exist
  on several machines. `projects_recent()` filters by local `is_dir` **only for local
  entries** — a remote existence check is an SSH round trip, and doing that per entry
  while rendering a menu would either block on the network or silently drop every remote
  project when the host is asleep.
- **Active project stays window-level**, matching today's `switchExecutionTarget`. Making
  it per-conversation would make the top-left label jump when switching sessions.
- Switching to a host resumes its **last project**, not the profile's directory — the
  recents list is already most-recent-first, so the first match for that target is it.

### Remote folder browsing

`pick()` returns a path from a native OS dialog and no version of it can enumerate an
SSH host, so `browse(targetId)` sits beside it rather than replacing it: locally the
native dialog stays (it knows shortcuts, drives, and habits), remotely the app draws the
listing itself. Every level is one SSH round trip, so `RemoteFolderPicker` shows its own
loading state instead of pretending to be instant.

### Editing a remote file

`ensureDoc` keeps the launcher's token per document and `saveFile` presents it, so the
editor can save remotely. Two states the UI now has to show:

- **Read-only** — a target whose port has no hashed writes (an old launcher). Marked in
  the breadcrumb, because "this app cannot do that here" beats a save that silently does
  nothing. Detected by asking the port, not by inspecting the target: a host can look
  fully capable and still resolve to a read-only port.
- **Conflict** — `DocConflictBar`, persistent, two named outcomes. A refused write is not
  a failure but a fork, and with pi editing the same tree it is routine rather than
  exceptional, so it must not be a toast that scrolls away. "Keep mine" is a second
  write against the hash *from the conflict*, never a force flag — if the file moved
  again in between it is refused again rather than overwriting a change nobody has seen.

### Also fixed

`.gitattributes` pins the launcher to `eol=lf`. It is embedded with `include_str!` and
run by `sh` on a POSIX host, so under `core.autocrlf=true` a Windows build would compile
CRLF into the binary and the shebang would fail on Linux. Latent until now only because
builds happened elsewhere.
