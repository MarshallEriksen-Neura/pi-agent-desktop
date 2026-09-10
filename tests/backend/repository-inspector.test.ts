import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type { BackendPorts } from "../../src/lib/backend/composition/container";
import type {
  RepositoryActionRequest,
  RepositoryActionResult,
  RepositoryMutationRequest,
  RepositorySnapshot,
} from "../../src/lib/backend/ports/repository";

const localBinding = { kind: "local", targetId: "local" } as const;

function snapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    kind: "repository",
    targetId: "local",
    workspaceRoot: "/repo",
    repoRoot: "/repo",
    generation: "generation-1",
    head: { kind: "branch", name: "main", oid: "head-1" },
    upstream: "origin/main",
    upstreamRemote: "origin",
    upstreamBranch: "main",
    upstreamOid: "upstream-1",
    mergeBaseOid: "head-1",
    ahead: 1,
    behind: 0,
    remotes: ["origin"],
    branches: [
      { name: "main", oid: "head-1" },
      { name: "topic", oid: "topic-1" },
    ],
    operation: null,
    files: [{
      path: "src/changed.ts",
      originalPath: null,
      indexStatus: "M",
      worktreeStatus: ".",
      staged: true,
      unstaged: false,
      untracked: false,
      conflicted: false,
    }],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function renderInspector(options: {
  initial?: RepositorySnapshot;
  action?: (request: RepositoryActionRequest) => Promise<RepositoryActionResult>;
  stagedDiff?: () => Promise<{ text: string }>;
  generateCommitMessage?: BackendPorts["sessionRepository"]["generateCommitMessage"];
  mutate?: BackendPorts["repository"]["mutate"];
  status?: BackendPorts["repository"]["status"];
}) {
  const [{ render, fireEvent, waitFor, cleanup, act }, React, browser, container, repositoryModule, workspaceModule, sessionsModule, piModule, extUiModule, componentModule] = await Promise.all([
    import("@testing-library/react"),
    import("react"),
    import("../../src/lib/backend/composition/browser"),
    import("../../src/lib/backend/composition/container"),
    import("../../src/lib/repository"),
    import("../../src/lib/workspace"),
    import("../../src/lib/pi/sessions"),
    import("../../src/lib/pi/store"),
    import("../../src/lib/pi/ext-ui"),
    import("../../src/components/RepositoryInspector"),
  ]);

  const initial = options.initial ?? snapshot();
  const actionCalls: RepositoryActionRequest[] = [];
  const mutationCalls: RepositoryMutationRequest[] = [];
  let statusCalls = 0;
  const ports = browser.createBrowserBackendPorts();
  const action = options.action ?? (async (request) => ({
    kind: "success",
    operation: request.operation,
    snapshot: initial,
  }));
  ports.repository = {
    status: async (request) => {
      statusCalls += 1;
      return options.status ? options.status(request) : initial;
    },
    diff: async (request) => ({
      identity: request,
      path: request.path,
      diffKind: request.diffKind,
      text: "",
      truncated: false,
    }),
    stagedDiff: options.stagedDiff ?? (async () => ({ text: "diff --git a/file b/file" })),
    mutate: async (request) => {
      mutationCalls.push(request);
      if (options.mutate) return options.mutate(request);
      return {
        kind: "success",
        operation: request.operation,
        snapshot: initial,
        commitOid: request.operation === "commit" ? "commit-1" : null,
      };
    },
    action: async (request) => {
      actionCalls.push(request);
      return action(request);
    },
  };
  if (options.generateCommitMessage) {
    ports.sessionRepository.generateCommitMessage = options.generateCommitMessage;
  }

  const originalWorkspaceState = workspaceModule.useWorkspace.getState();
  const originalSessionsState = sessionsModule.useSessions.getState();
  const originalExtUiState = extUiModule.useExtUi.getState();
  container.resetBackendContainerForTests();
  container.configureBrowserBackend(ports);
  repositoryModule.useRepository.getState().clear();
  workspaceModule.useWorkspace.setState({ root: "/repo", targetId: "local" });
  sessionsModule.useSessions.setState({ activeId: null, executionBinding: localBinding });
  piModule.usePi.setState({ status: "ready", currentModel: null });
  const toasts: Array<{ message: string; kind: string }> = [];
  extUiModule.useExtUi.setState({
    toasts: [],
    pushToast: (message: string, kind = "info") => { toasts.push({ message, kind }); },
  });

  const view = render(React.createElement(componentModule.RepositoryInspector));
  await waitFor(() => {
    assert.ok(view.getByRole("button", { name: "Push" }));
    assert.equal(repositoryModule.useRepository.getState().loading, false);
    assert.equal(repositoryModule.useRepository.getState().result?.kind, "repository");
    assert.ok(view.getByRole("button", { name: "Fetch" }));
  });

  return {
    ...view,
    fireEvent,
    waitFor,
    act,
    actionCalls,
    mutationCalls,
    statusCalls: () => statusCalls,
    toasts,
    stores: {
      repository: repositoryModule.useRepository,
      workspace: workspaceModule.useWorkspace,
      pi: piModule.usePi,
    },
    dispose: () => {
      cleanup();
      repositoryModule.useRepository.getState().clear();
      piModule.resetPiStoreForTests();
      workspaceModule.useWorkspace.setState(originalWorkspaceState, true);
      sessionsModule.useSessions.setState(originalSessionsState, true);
      extUiModule.useExtUi.setState(originalExtUiState, true);
      container.resetBackendContainerForTests();
    },
  };
}

describe("Repository Inspector reviewed Git workflows", () => {
  before(async () => {
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
    GlobalRegistrator.register();
  });

  after(async () => {
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
    await GlobalRegistrator.unregister();
  });

test("Repository Inspector confirms the exact reviewed push destination before pushing", async () => {
  const ui = await renderInspector({ initial: snapshot({ remotes: ["origin", "fork"] }) });
  try {
    const fetchRemote = ui.getByLabelText("Remote to fetch") as HTMLSelectElement;
    assert.match(fetchRemote.className, /pi-native-select/);
    assert.match(fetchRemote.className, /repository-control/);
    ui.fireEvent.change(fetchRemote, { target: { value: "fork" } });
    assert.equal(fetchRemote.value, "fork");
    assert.equal((ui.getByRole("button", { name: "Push" }) as HTMLButtonElement).disabled, false);
    assert.equal(ui.queryByRole("button", { name: "Fast-forward" }), null);
    assert.equal(ui.queryByRole("button", { name: "Review integration" }), null);
    assert.equal(ui.queryByLabelText("Integration strategy"), null);
    ui.fireEvent.click(ui.getByRole("button", { name: "Push" }));
    assert.equal(ui.actionCalls.length, 0);

    const dialog = ui.getByRole("dialog", { name: "Push this branch?" });
    assert.match(dialog.textContent ?? "", /main → origin\/main/);
    ui.fireEvent.click(ui.getByRole("button", { name: "Push current branch" }));

    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    assert.deepEqual(ui.actionCalls[0], {
      operation: "push",
      targetId: "local",
      workspaceRoot: "/repo",
      repoRoot: "/repo",
      generation: "generation-1",
      executionBinding: localBinding,
      expectedHeadOid: "head-1",
      expectedUpstreamOid: "upstream-1",
      expectedUpstreamRemote: "origin",
      expectedUpstreamBranch: "main",
    });
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector confirms the exact reviewed fast-forward direction before integration", async () => {
  const initial = snapshot({ ahead: 0, behind: 1, files: [] });
  const ui = await renderInspector({ initial });
  try {
    assert.equal((ui.getByRole("button", { name: "Push" }) as HTMLButtonElement).disabled, true);
    assert.equal(ui.queryByLabelText("Integration strategy"), null);
    assert.match(ui.container.textContent ?? "", /1 reviewed upstream commit/);
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward" }));
    assert.equal(ui.actionCalls.length, 0);

    const dialog = ui.getByRole("dialog", { name: "Fast-forward this branch?" });
    assert.match(dialog.textContent ?? "", /main ← origin\/main/);
    assert.match(dialog.textContent ?? "", /no network request/i);
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward local branch" }));

    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    assert.deepEqual(ui.actionCalls[0], {
      operation: "integrateFastForward",
      targetId: "local",
      workspaceRoot: "/repo",
      repoRoot: "/repo",
      generation: "generation-1",
      executionBinding: localBinding,
      expectedLocalBranch: "main",
      expectedHeadOid: "head-1",
      expectedUpstreamRemote: "origin",
      expectedUpstreamBranch: "main",
      expectedUpstreamOid: "upstream-1",
      expectedMergeBaseOid: "head-1",
      strategy: "fastForwardOnly",
    });
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector refuses a reviewed integration after generation changes", async () => {
  const ui = await renderInspector({ initial: snapshot({ ahead: 0, behind: 1, files: [] }) });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward" }));
    assert.ok(ui.getByRole("dialog", { name: "Fast-forward this branch?" }));
    await ui.act(async () => {
      ui.stores.repository.setState((state) => ({
        result: state.result?.kind === "repository"
          ? { ...state.result, generation: "generation-2" }
          : state.result,
      }));
    });
    // AnimatePresence retains the exiting node under Happy DOM. Do not wait for its
    // requestAnimationFrame-driven exit; exercising any retained button also proves
    // the generation re-check prevents a stale dispatch.
    const exitingConfirm = ui.queryByRole("button", { name: "Fast-forward local branch" });
    if (exitingConfirm) ui.fireEvent.click(exitingConfirm);
    await ui.act(async () => Promise.resolve());
    assert.equal(ui.actionCalls.length, 0);
    assert.equal(ui.toasts.length, 0);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector refreshes after an applied integration failure", async () => {
  const ui = await renderInspector({
    initial: snapshot({ ahead: 0, behind: 1, files: [] }),
    action: async () => ({
      kind: "failure",
      operation: "integrateFastForward",
      reason: "refreshFailed",
      detail: "Integration applied, but refresh failed.",
      applied: true,
    }),
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward" }));
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward local branch" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    await ui.waitFor(() => assert.ok(ui.statusCalls() >= 2));
    assert.equal(ui.stores.repository.getState().mutating, false);
    assert.equal(ui.stores.repository.getState().mutationError?.reason, "refreshFailed");
    assert.ok(ui.toasts.some((toast) => toast.kind === "error"));
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector refreshes after an indeterminate integration transport failure", async () => {
  const ui = await renderInspector({
    initial: snapshot({ ahead: 0, behind: 1, files: [] }),
    action: async () => { throw new Error("transport response lost"); },
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward" }));
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward local branch" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    await ui.waitFor(() => assert.ok(ui.statusCalls() >= 2));
    const failure = ui.stores.repository.getState().mutationError;
    assert.equal(failure?.reason, "refreshFailed");
    assert.equal(failure?.applied, true);
    assert.ok(ui.toasts.some((toast) => toast.kind === "error"));
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector discards pending action results after the repository scope changes", async () => {
  const pending = deferred<RepositoryActionResult>();
  const ui = await renderInspector({ action: async () => pending.promise });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Fetch" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));

    ui.stores.workspace.setState({ root: "/other-repo", targetId: "local" });
    await ui.waitFor(() => assert.match(ui.stores.repository.getState().scopeKey ?? "", /other-repo/));

    pending.resolve({
      kind: "success",
      operation: "fetch",
      snapshot: snapshot({ generation: "stale-action-generation" }),
    });
    await ui.waitFor(() => assert.equal(ui.stores.repository.getState().mutating, false));

    const scopedResult = ui.stores.repository.getState().result;
    assert.notEqual(
      scopedResult?.kind === "repository" ? scopedResult.generation : null,
      "stale-action-generation",
    );
    assert.equal(ui.toasts.length, 0);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector suppresses an action failure after a newer same-scope refresh", async () => {
  const pending = deferred<RepositoryActionResult>();
  const ui = await renderInspector({ action: async () => pending.promise });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Fetch" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));

    await ui.act(async () => {
      ui.stores.repository.setState((state) => ({
        result: state.result?.kind === "repository"
          ? { ...state.result, generation: "generation-2" }
          : state.result,
      }));
    });
    pending.resolve({
      kind: "failure",
      operation: "fetch",
      reason: "gitUnavailable",
      detail: "stale network failure",
      applied: false,
    });
    await ui.waitFor(() => assert.equal(ui.stores.repository.getState().mutating, false));

    const refreshedResult = ui.stores.repository.getState().result;
    assert.equal(
      refreshedResult?.kind === "repository" ? refreshedResult.generation : null,
      "generation-2",
    );
    assert.equal(ui.toasts.length, 0);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector suppresses an indeterminate integration failure after a newer refresh", async () => {
  const pending = deferred<RepositoryActionResult>();
  const ui = await renderInspector({
    initial: snapshot({ ahead: 0, behind: 1, files: [] }),
    action: async () => pending.promise,
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward" }));
    ui.fireEvent.click(ui.getByRole("button", { name: "Fast-forward local branch" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    await ui.act(async () => {
      ui.stores.repository.setState((state) => ({
        result: state.result?.kind === "repository"
          ? { ...state.result, generation: "generation-2" }
          : state.result,
      }));
    });
    pending.reject(new Error("stale transport failure"));
    await ui.waitFor(() => assert.equal(ui.stores.repository.getState().mutating, false));
    await ui.waitFor(() => assert.ok(ui.statusCalls() >= 2));
    assert.equal(ui.stores.repository.getState().mutationError, null);
    assert.equal(ui.toasts.length, 0);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector drives bounded branch actions and disables writes while Pi runs", async () => {
  const ui = await renderInspector({});
  try {
    assert.equal(ui.queryByLabelText("Local branch to switch to"), null);
    assert.equal(ui.queryByLabelText("New local branch"), null);
    const branchActions = ui.getByRole("button", { name: /Branch actions/ });
    assert.equal(branchActions.getAttribute("aria-expanded"), "false");
    ui.fireEvent.click(branchActions);
    assert.equal(branchActions.getAttribute("aria-expanded"), "true");
    const branchSelect = ui.getByLabelText("Local branch to switch to") as HTMLSelectElement;
    assert.match(branchSelect.className, /pi-native-select/);
    assert.match(branchSelect.className, /repository-control/);
    ui.fireEvent.change(ui.getByLabelText("Local branch to switch to"), { target: { value: "topic" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Switch" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    assert.equal(ui.actionCalls[0]?.operation, "switchBranch");
    assert.equal(ui.actionCalls[0]?.branchName, "topic");

    ui.fireEvent.change(ui.getByLabelText("New local branch"), { target: { value: "reviewed-topic" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Create" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 2));
    assert.equal(ui.actionCalls[1]?.operation, "createBranch");
    assert.equal(ui.actionCalls[1]?.branchName, "reviewed-topic");
    assert.equal(ui.actionCalls[1]?.expectedHeadOid, "head-1");

    await ui.act(async () => {
      ui.stores.pi.setState({ status: "running" });
    });
    await ui.waitFor(() => {
      assert.equal((ui.getByRole("button", { name: "Fetch" }) as HTMLButtonElement).disabled, true);
      assert.equal((ui.getByRole("button", { name: "Push" }) as HTMLButtonElement).disabled, true);
      assert.equal(ui.queryByRole("button", { name: "Fast-forward" }), null);
      assert.equal((ui.getByRole("button", { name: "Switch" }) as HTMLButtonElement).disabled, true);
      assert.equal((ui.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled, true);
      assert.match(ui.container.textContent ?? "", /Git writes are disabled while Pi is running/);
    });
    const blocked = await ui.stores.repository.getState().action({ operation: "fetch", remote: "origin" });
    assert.equal(blocked?.kind, "failure");
    assert.equal(blocked?.kind === "failure" ? blocked.reason : null, "piBusy");
    assert.equal(blocked?.kind === "failure" ? blocked.applied : null, false);
    assert.equal(ui.actionCalls.length, 2);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector keeps AI output editable and never commits it automatically", async () => {
  const generateCalls: unknown[] = [];
  const ui = await renderInspector({
    generateCommitMessage: async (input) => {
      generateCalls.push(input);
      return "feat: generated draft";
    },
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Draft with AI" }));
    const textarea = ui.getByLabelText("Commit message") as HTMLTextAreaElement;
    await ui.waitFor(() => assert.equal(textarea.value, "feat: generated draft"));
    assert.deepEqual(generateCalls, [{
      stagedDiff: "diff --git a/file b/file",
      provider: null,
      modelId: null,
    }]);
    assert.equal(ui.actionCalls.length, 0);

    ui.fireEvent.change(textarea, { target: { value: "feat: human-reviewed draft" } });
    assert.equal(textarea.value, "feat: human-reviewed draft");
    ui.fireEvent.click(ui.getByRole("button", { name: "Commit 1 staged" }));
    assert.ok(ui.getByRole("dialog", { name: "Create this commit?" }));
    assert.equal(ui.actionCalls.length, 0);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector localizes identityUnavailable for an ordinary reviewed commit", async () => {
  const ui = await renderInspector({
    mutate: async (request) => ({
      kind: "failure",
      operation: request.operation,
      reason: "identityUnavailable",
      detail: "raw Git identity failure",
      applied: false,
    }),
  });
  try {
    const textarea = ui.getByLabelText("Commit message") as HTMLTextAreaElement;
    ui.fireEvent.change(textarea, { target: { value: "reviewed commit" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Commit 1 staged" }));
    ui.fireEvent.click(ui.getByRole("button", { name: "Commit staged changes" }));
    await ui.waitFor(() => assert.equal(ui.toasts.length, 1));
    assert.deepEqual(ui.toasts[0], {
      kind: "error",
      message: "Git identity is unavailable for creating or rewriting reviewed commits.",
    });
    assert.equal(textarea.value, "reviewed commit");
    assert.equal(ui.mutationCalls.length, 1);
    assert.equal(ui.mutationCalls[0]?.operation, "commit");
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
  } finally {
    ui.dispose();
  }
});


test("Repository Inspector localizes unavailable HTTPS credentials without exposing backend detail", async () => {
  const ui = await renderInspector({
    action: async (request) => ({
      kind: "failure",
      operation: request.operation,
      reason: "remoteAuthenticationUnavailable",
      detail: "secret credential diagnostic",
      applied: false,
    }),
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Fetch" }));
    await ui.waitFor(() => assert.equal(ui.toasts.length, 1));
    assert.deepEqual(ui.toasts[0], {
      kind: "error",
      message: "Git credentials for this HTTPS remote are unavailable. Sign in with the operating system's Git Credential Manager, then try again.",
    });
    assert.doesNotMatch(ui.toasts[0]?.message ?? "", /secret credential diagnostic/);
    assert.equal(ui.actionCalls[0]?.operation, "fetch");
  } finally {
    ui.dispose();
  }
});
test("Repository Inspector explains an unavailable AI model without exposing raw backend errors", async () => {
  const ui = await renderInspector({
    generateCommitMessage: async () => {
      throw new Error("invoke failed: commit draft generation failed: modelUnavailable; secret=hidden");
    },
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Draft with AI" }));
    await ui.waitFor(() => {
      assert.equal(ui.toasts.length, 1);
      assert.equal(
        ui.toasts[0]?.message,
        "The selected AI provider or model is unavailable. Choose an available model and try again.",
      );
      assert.equal(ui.toasts[0]?.kind, "error");
      assert.doesNotMatch(ui.toasts[0]?.message ?? "", /secret=hidden/);
    });
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector explains an oversized staged diff before invoking AI", async () => {
  let generateCalls = 0;
  const ui = await renderInspector({
    stagedDiff: async () => {
      throw new Error("stagedDiffTooLarge");
    },
    generateCommitMessage: async () => {
      generateCalls += 1;
      return "should not be generated";
    },
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Draft with AI" }));
    await ui.waitFor(() => {
      assert.equal(ui.toasts.length, 1);
      assert.equal(
        ui.toasts[0]?.message,
        "The staged diff exceeds the 256 KiB AI-draft limit. Unstage unrelated files or split this commit, then try again.",
      );
      assert.equal(ui.toasts[0]?.kind, "error");
    });
    assert.equal(generateCalls, 0);
  } finally {
    ui.dispose();
  }
});
test("Repository Inspector blocks an open commit confirmation while refresh is pending", async () => {
  const initial = snapshot();
  const pending = deferred<RepositorySnapshot>();
  let calls = 0;
  const ui = await renderInspector({
    initial,
    status: async () => {
      calls += 1;
      return calls === 1 ? initial : pending.promise;
    },
  });
  try {
    ui.fireEvent.change(ui.getByLabelText("Commit message"), { target: { value: "reviewed commit" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Commit 1 staged" }));
    const confirm = ui.getByRole("button", { name: "Commit staged changes" }) as HTMLButtonElement;
    assert.equal(confirm.disabled, false);
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    ui.fireEvent.click(ui.getByRole("button", { name: "Refresh repository status" }));
    await ui.waitFor(() => assert.equal(ui.stores.repository.getState().loading, true));
    assert.equal(confirm.disabled, true);
    ui.fireEvent.click(confirm);
    ui.fireEvent.keyDown(window, { key: "Enter" });
    assert.equal(ui.mutationCalls.length, 0);
    ui.fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    await ui.act(async () => {
      pending.resolve(snapshot({ generation: "generation-2" }));
      await pending.promise;
    });
  } finally {
    pending.resolve(snapshot({ generation: "generation-2" }));
    ui.dispose();
  }
});
test("Repository Inspector blocks an open commit confirmation during another mutation", async () => {
  const initial = snapshot();
  const pending = deferred<Awaited<ReturnType<BackendPorts["repository"]["mutate"]>>>();
  const ui = await renderInspector({ initial, mutate: async () => pending.promise });
  try {
    ui.fireEvent.change(ui.getByLabelText("Commit message"), { target: { value: "reviewed commit" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Commit 1 staged" }));
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    const confirm = ui.getByRole("button", { name: "Commit staged changes" }) as HTMLButtonElement;
    ui.fireEvent.click(ui.getByRole("button", { name: "Unstage all 1 staged files" }));
    await ui.waitFor(() => assert.equal(ui.stores.repository.getState().mutating, true));
    assert.equal(confirm.disabled, true);
    ui.fireEvent.click(confirm);
    ui.fireEvent.keyDown(window, { key: "Enter" });
    assert.equal(ui.mutationCalls.length, 1);
    assert.equal(ui.mutationCalls[0]?.operation, "unstageBatch");
    ui.fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    await ui.act(async () => {
      pending.resolve({ kind: "success", operation: "unstageBatch", snapshot: initial, commitOid: null });
      await pending.promise;
    });
  } finally {
    pending.resolve({ kind: "success", operation: "unstageBatch", snapshot: initial, commitOid: null });
    ui.dispose();
  }
});



test("Repository Inspector discards an AI draft when the reviewed generation changes", async () => {
  const generated = deferred<string>();
  const ui = await renderInspector({
    generateCommitMessage: async () => generated.promise,
  });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Draft with AI" }));
    await ui.waitFor(() => {
      assert.equal((ui.getByRole("button", { name: "Draft with AI" }) as HTMLButtonElement).disabled, true);
    });

    await ui.act(async () => {
      ui.stores.repository.setState((state) => ({
        result: state.result?.kind === "repository"
          ? { ...state.result, generation: "generation-2" }
          : state.result,
      }));
    });
    generated.resolve("feat: stale draft");

    const textarea = ui.getByLabelText("Commit message") as HTMLTextAreaElement;
    await ui.waitFor(() => {
      assert.equal((ui.getByRole("button", { name: "Draft with AI" }) as HTMLButtonElement).disabled, false);
      assert.equal(textarea.value, "");
    });
    assert.equal(ui.toasts.some((toast) => toast.message.includes("AI commit draft generated")), false);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector freezes and dispatches the exact reviewed merge intent", async () => {
  const initial = snapshot({
    ahead: 2, behind: 3, files: [], mergeBaseOid: "base-1",
    head: { kind: "branch", name: "topic", oid: "head-2" },
    upstreamBranch: "main", upstreamOid: "upstream-2",
  });
  const ui = await renderInspector({ initial });
  try {
    assert.equal((ui.getByRole("button", { name: "Push" }) as HTMLButtonElement).disabled, true);
    assert.equal(ui.queryByRole("button", { name: "Fast-forward" }), null);
    assert.match(ui.container.textContent ?? "", /Diverged · 2 local \/ 3 upstream/);
    const strategy = ui.getByLabelText("Integration strategy") as HTMLSelectElement;
    assert.match(strategy.className, /pi-native-select/);
    assert.match(strategy.className, /repository-control/);
    assert.equal(strategy.value, "mergeCommit");
    ui.fireEvent.change(ui.getByLabelText("Integration strategy"), { target: { value: "mergeCommit" } });
    const mergeMessageInput = ui.getByLabelText("Merge commit message");
    ui.fireEvent.change(mergeMessageInput, {
      target: { value: "  Merge reviewed histories  " },
    });
    ui.fireEvent.click(ui.getByRole("button", { name: "Review integration" }));
    ui.fireEvent.change(mergeMessageInput, { target: { value: "Unreviewed replacement" } });
    const dialog = ui.getByRole("dialog", { name: "Merge these reviewed histories?" });
    assert.match(dialog.textContent ?? "", /topic ← origin\/main/);
    assert.match(dialog.textContent ?? "", /Merge commit/);
    assert.match(dialog.textContent ?? "", /no network request/i);
    assert.match(dialog.textContent ?? "", /Merge reviewed histories/);
    assert.match(dialog.textContent ?? "", /Repository: \/repo/);
    assert.match(dialog.textContent ?? "", /Generation: generation-1/);
    assert.match(dialog.textContent ?? "", /Local HEAD: head-2/);
    assert.match(dialog.textContent ?? "", /Reviewed upstream: upstream-2/);
    assert.match(dialog.textContent ?? "", /Merge base: base-1/);
    ui.fireEvent.click(ui.getByRole("button", { name: "Create reviewed merge" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    assert.deepEqual(ui.actionCalls[0], {
      operation: "integrateMerge", targetId: "local", workspaceRoot: "/repo", repoRoot: "/repo",
      generation: "generation-1", executionBinding: localBinding, expectedLocalBranch: "topic",
      expectedHeadOid: "head-2", expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
      expectedUpstreamOid: "upstream-2", expectedMergeBaseOid: "base-1",
      strategy: "mergeCommit", message: "Merge reviewed histories",
    });
  } finally {
    ui.dispose();
  }
});
test("Repository Inspector does not dispatch a reviewed merge while refresh is pending", async () => {
  const ui = await renderInspector({
    initial: snapshot({
      ahead: 1, behind: 1, files: [], mergeBaseOid: "base-1",
      head: { kind: "branch", name: "topic", oid: "head-2" },
      upstreamOid: "upstream-2",
    }),
  });
  try {
    ui.fireEvent.change(ui.getByLabelText("Integration strategy"), { target: { value: "mergeCommit" } });
    ui.fireEvent.change(ui.getByLabelText("Merge commit message"), { target: { value: "Reviewed merge" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Review integration" }));
    assert.ok(ui.getByRole("dialog", { name: "Merge these reviewed histories?" }));
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    await ui.act(async () => {
      ui.stores.repository.setState({ loading: true });
    });
    const retainedConfirm = ui.getByRole("button", { name: "Create reviewed merge" }) as HTMLButtonElement;
    assert.equal(retainedConfirm.disabled, true);
    ui.fireEvent.click(retainedConfirm);
    await ui.act(async () => Promise.resolve());
    assert.equal(ui.actionCalls.length, 0);
    assert.equal(ui.toasts.length, 0);
    ui.fireEvent.click(ui.getByRole("button", { name: "Cancel" }));
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
  } finally {
    ui.dispose();
  }
});


test("Repository Inspector dispatches reviewed linear rebase without a message field", async () => {
  const initial = snapshot({
    ahead: 1, behind: 1, files: [], mergeBaseOid: "base-1",
    head: { kind: "branch", name: "topic", oid: "head-2" },
    upstreamOid: "upstream-2",
  });
  const ui = await renderInspector({ initial });
  try {
    ui.fireEvent.change(ui.getByLabelText("Integration strategy"), { target: { value: "rebaseLinear" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Review integration" }));
    const dialog = ui.getByRole("dialog", { name: "Rebase this reviewed local history?" });
    assert.match(dialog.textContent ?? "", /topic ← origin\/main/);
    assert.match(dialog.textContent ?? "", /Linear rebase/);
    assert.match(dialog.textContent ?? "", /not Pull/);
    assert.match(dialog.textContent ?? "", /Repository: \/repo/);
    assert.match(dialog.textContent ?? "", /Generation: generation-1/);
    assert.match(dialog.textContent ?? "", /Local HEAD: head-2/);
    assert.match(dialog.textContent ?? "", /Reviewed upstream: upstream-2/);
    assert.match(dialog.textContent ?? "", /Merge base: base-1/);
    ui.fireEvent.click(ui.getByRole("button", { name: "Rebase reviewed commits" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    assert.deepEqual(ui.actionCalls[0], {
      operation: "integrateRebase", targetId: "local", workspaceRoot: "/repo", repoRoot: "/repo",
      generation: "generation-1", executionBinding: localBinding, expectedLocalBranch: "topic",
      expectedHeadOid: "head-2", expectedUpstreamRemote: "origin", expectedUpstreamBranch: "main",
      expectedUpstreamOid: "upstream-2", expectedMergeBaseOid: "base-1", strategy: "rebaseLinear",
    });
    assert.equal(Object.hasOwn(ui.actionCalls[0] ?? {}, "message"), false);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector enforces the reviewed merge message UTF-8 byte bound", async () => {
  const ui = await renderInspector({ initial: snapshot({ ahead: 1, behind: 1, files: [], mergeBaseOid: "base-1" }) });
  try {
    ui.fireEvent.change(ui.getByLabelText("Integration strategy"), { target: { value: "mergeCommit" } });
    const message = ui.getByLabelText("Merge commit message");
    const merge = ui.getByRole("button", { name: "Review integration" }) as HTMLButtonElement;
    ui.fireEvent.change(message, { target: { value: "   " } });
    assert.equal(merge.disabled, true);
    ui.fireEvent.change(message, { target: { value: "界".repeat(1366) } });
    assert.equal(merge.disabled, true);
    assert.match(ui.container.textContent ?? "", /4098 \/ 4096 UTF-8 bytes/);
    assert.equal(ui.actionCalls.length, 0);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector reports a verified merge conflict without a success toast", async () => {
  const ui = await renderInspector({
    initial: snapshot({ ahead: 1, behind: 1, files: [], mergeBaseOid: "base-1" }),
    action: async () => ({
      kind: "failure", operation: "integrateMerge", reason: "integrationConflict",
      detail: "restoration verified", applied: false,
    }),
  });
  try {
    ui.fireEvent.change(ui.getByLabelText("Integration strategy"), { target: { value: "mergeCommit" } });
    ui.fireEvent.change(ui.getByLabelText("Merge commit message"), { target: { value: "Reviewed merge" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Review integration" }));
    ui.fireEvent.click(ui.getByRole("button", { name: "Create reviewed merge" }));
    await ui.waitFor(() => assert.equal(ui.stores.repository.getState().mutationError?.reason, "integrationConflict"));
    assert.equal(ui.toasts.some((toast) => toast.kind === "success"), false);
    assert.ok(ui.toasts.some((toast) => toast.kind === "error"));
    assert.match(ui.toasts.find((toast) => toast.kind === "error")?.message ?? "", /aborted automatically/i);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector treats a lost rebase response as applied ambiguity and refreshes", async () => {
  const ui = await renderInspector({
    initial: snapshot({ ahead: 1, behind: 1, files: [], mergeBaseOid: "base-1" }),
    action: async () => { throw new Error("rebase response lost"); },
  });
  try {
    ui.fireEvent.change(ui.getByLabelText("Integration strategy"), { target: { value: "rebaseLinear" } });
    ui.fireEvent.click(ui.getByRole("button", { name: "Review integration" }));
    ui.fireEvent.click(ui.getByRole("button", { name: "Rebase reviewed commits" }));
    await ui.waitFor(() => assert.equal(ui.actionCalls.length, 1));
    await ui.waitFor(() => assert.ok(ui.statusCalls() >= 2));
    const failure = ui.stores.repository.getState().mutationError;
    assert.equal(failure?.reason, "refreshFailed");
    assert.equal(failure?.applied, true);
  } finally {
    ui.dispose();
  }
});
test("Repository Inspector stages and unstages groups with one reviewed batch request", async () => {
  const staged: RepositorySnapshot["files"][number] = {
    path: "src/staged.ts", originalPath: null, indexStatus: "M", worktreeStatus: ".",
    staged: true, unstaged: false, untracked: false, conflicted: false,
  };
  const unstaged: RepositorySnapshot["files"][number] = {
    path: "src/current.ts", originalPath: "src/original.ts", indexStatus: ".", worktreeStatus: "M",
    staged: false, unstaged: true, untracked: false, conflicted: false,
  };
  const ui = await renderInspector({ initial: snapshot({ files: [staged, unstaged] }) });
  try {
    ui.fireEvent.click(ui.getByRole("button", { name: "Stage all 1 unstaged files" }));
    await ui.waitFor(() => assert.equal(ui.mutationCalls.length, 1));
    assert.deepEqual(ui.mutationCalls[0], {
      operation: "stageBatch", targetId: "local", workspaceRoot: "/repo", repoRoot: "/repo",
      generation: "generation-1", executionBinding: localBinding,
      files: [{ path: "src/current.ts", originalPath: "src/original.ts" }],
    });
    ui.fireEvent.click(ui.getByRole("button", { name: "Unstage all 1 staged files" }));
    await ui.waitFor(() => assert.equal(ui.mutationCalls.length, 2));
    assert.deepEqual(ui.mutationCalls[1], {
      operation: "unstageBatch", targetId: "local", workspaceRoot: "/repo", repoRoot: "/repo",
      generation: "generation-1", executionBinding: localBinding,
      files: [{ path: "src/staged.ts", originalPath: null }],
    });
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector commit helper stages unstaged and untracked files without committing", async () => {
  const unstaged: RepositorySnapshot["files"][number] = {
    path: "src/current.ts", originalPath: null, indexStatus: ".", worktreeStatus: "M",
    staged: false, unstaged: true, untracked: false, conflicted: false,
  };
  const untracked: RepositorySnapshot["files"][number] = {
    path: "src/new.ts", originalPath: null, indexStatus: "?", worktreeStatus: "?",
    staged: false, unstaged: true, untracked: true, conflicted: false,
  };
  const ui = await renderInspector({ initial: snapshot({ files: [unstaged, untracked] }) });
  try {
    const helper = ui.getByRole("button", { name: "Stage all 2 unstaged and untracked files" });
    ui.fireEvent.click(helper);
    await ui.waitFor(() => assert.equal(ui.mutationCalls.length, 1));
    assert.deepEqual(ui.mutationCalls[0]?.operation, "stageBatch");
    assert.deepEqual(ui.mutationCalls[0], {
      operation: "stageBatch", targetId: "local", workspaceRoot: "/repo", repoRoot: "/repo",
      generation: "generation-1", executionBinding: localBinding,
      files: [
        { path: "src/current.ts", originalPath: null },
        { path: "src/new.ts", originalPath: null },
      ],
    });
    assert.equal(ui.mutationCalls.some((call) => call.operation === "commit"), false);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector commit helper names single-category staging scopes accurately", async () => {
  const unstaged: RepositorySnapshot["files"][number] = {
    path: "src/current.ts", originalPath: null, indexStatus: ".", worktreeStatus: "M",
    staged: false, unstaged: true, untracked: false, conflicted: false,
  };
  const untracked: RepositorySnapshot["files"][number] = {
    path: "src/new.ts", originalPath: null, indexStatus: "?", worktreeStatus: "?",
    staged: false, unstaged: true, untracked: true, conflicted: false,
  };
  for (const [file, expected] of [
    [unstaged, "Stage all 1 unstaged files"],
    [untracked, "Stage all 1 untracked files"],
  ] as const) {
    const ui = await renderInspector({ initial: snapshot({ files: [file] }) });
    try {
      const helper = ui.container.querySelector<HTMLButtonElement>(".repository-stage-helper button");
      assert.equal(helper?.getAttribute("aria-label"), expected);
      await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
    } finally {
      ui.dispose();
    }
  }
});

test("Repository Inspector refreshes after an indeterminate batch staging transport failure", async () => {
  const unstaged: RepositorySnapshot["files"][number] = {
    path: "src/current.ts", originalPath: null, indexStatus: ".", worktreeStatus: "M",
    staged: false, unstaged: true, untracked: false, conflicted: false,
  };
  const ui = await renderInspector({
    initial: snapshot({ files: [unstaged] }),
    mutate: async () => { throw new Error("batch response lost"); },
  });
  try {
    const batch = ui.getAllByRole("button", { name: "Stage all 1 unstaged files" })[0];
    assert.ok(batch);
    ui.fireEvent.click(batch);
    await ui.waitFor(() => assert.equal(ui.mutationCalls.length, 1));
    await ui.waitFor(() => assert.ok(ui.statusCalls() >= 2));
    const failure = ui.stores.repository.getState().mutationError;
    assert.equal(failure?.reason, "refreshFailed");
    assert.equal(failure?.applied, true);
  } finally {
    ui.dispose();
  }
});

test("Repository Inspector visibly explains conflict-blocked batch staging", async () => {
  const conflict: RepositorySnapshot["files"][number] = {
    path: "src/conflict.ts", originalPath: null, indexStatus: "U", worktreeStatus: "U",
    staged: true, unstaged: true, untracked: false, conflicted: true,
  };
  const unstaged: RepositorySnapshot["files"][number] = {
    path: "src/current.ts", originalPath: null, indexStatus: ".", worktreeStatus: "M",
    staged: false, unstaged: true, untracked: false, conflicted: false,
  };
  const ui = await renderInspector({ initial: snapshot({ files: [conflict, unstaged] }) });
  try {
    const guidance = ui.getByText("Resolve 1 conflicted file(s) first. Batch staging never includes conflicts.");
    assert.equal(guidance.id, "repository-conflict-batch-guidance");
    const blockedBatchActions = ui.getAllByRole("button", { name: "Stage all 1 unstaged files" }) as HTMLButtonElement[];
    assert.equal(blockedBatchActions.length, 2);
    for (const batch of blockedBatchActions) {
      assert.equal(batch.disabled, true);
      assert.equal(batch.getAttribute("aria-describedby"), guidance.id);
    }
    assert.equal((ui.getByRole("button", { name: "Fetch" }) as HTMLButtonElement).disabled, true);
    assert.equal((ui.getByRole("button", { name: "Push" }) as HTMLButtonElement).disabled, true);
    assert.equal((ui.getByLabelText("Commit message") as HTMLTextAreaElement).disabled, true);
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 500)));
  } finally {
    ui.dispose();
  }
});

});
