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

### V2.R-1 — resolution seam (no behaviour change)

1. `createWorkspaceFs` on `BackendPorts`; desktop + browser compositions supply it. SSH branch = fail-closed stub.
2. `workspaceFsFor(targetId)` helper; `workspace.ts`'s 11 call sites and the 2 outliers route through it.
3. `targetId` on the store, defaulting to `"local"`.
4. `configureWorkspaceTargetSwitch` seam; `switchExecutionTarget` calls it; `AppShell` registers it.
5. Update the two locked lists (`command-inventory.test.ts`, `check-backend-boundaries.mjs`) if any new command appears — Step 1 adds none.

Verification: existing suites stay at the 3 known baseline failures. New tests — a remote binding resolves to a port that refuses every call; switching to SSH clears the tree and sets `targetId`; switching back restores local.

### V2.R-2 — remote browsing (folds into V2.3)

Only now does a real remote implementation appear, and only the read half:

- launcher gains a bounded `--workspace` mode: list directory, read file, stat. Fixed operations, bounded output, absolute paths only, symlink rejection — reusing the provider-sync path discipline verbatim.
- gate it behind `hasLauncherCapability(probe, "workspace-v1")`, the V2.0 handshake already shipped.
- `pick()` gains a sibling `browse(targetId)`: local keeps the native dialog, SSH returns a remote directory listing rendered by the existing file-tree component. **The tree component does not change** — it already renders `FsEntry[]` and is agnostic about where the entries came from.
- `remoteCwd` in `RemoteAgentSettings` becomes selectable via that listing instead of a hand-typed field, which is the thing that prompted this.

## What is deliberately not in scope

- No writes. `WorkspaceFsPort`'s mutating methods stay refused on SSH until V2.4, which owns hash-checked writes.
- No `WorkspaceRef` union threaded through the UI. Considered and rejected: 17 component touch points to encode something a single store field already determines.
- No change to `WorkspaceFsPort`'s signatures. If the port shape has to change, the design is wrong — the host belongs to the instance.
- No caching of remote listings beyond what the store already does per directory.

## Ordering

V2.R-1 and V2.1 (detached tasks + event journal) do not overlap: V2.1 is launcher JS plus Rust argv, V2.R-1 is frontend port wiring. They can run in parallel. V2.R-1 must land before V2.3 — doing V2.3 on bare string paths means doing it twice.
