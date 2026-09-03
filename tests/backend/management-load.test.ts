import assert from "node:assert/strict";
import test from "node:test";

import {
  configureBrowserBackend,
  resetBackendContainerForTests,
  type BackendPorts,
} from "../../src/lib/backend/composition/container";
import type {
  PiManagementAvailability,
  PiManagementPort,
  PiManagementPortFactory,
  PiManagementSnapshot,
} from "../../src/lib/backend/ports/pi-management";
import { usePiManagement } from "../../src/lib/pi/management";
import { useSessions } from "../../src/lib/pi/sessions";
import { useWorkspace } from "../../src/lib/workspace";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const readable: PiManagementAvailability = {
  capabilities: ["pi-packages-read-v1", "pi-skills-read-v1"],
  launcherOutdated: false,
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(targetKey: string, stateToken: string): PiManagementSnapshot {
  return {
    targetKey,
    stateToken,
    globalSettings: { path: "/global/settings.json", exists: false, content: "" },
    projectSettings: { path: "/project/settings.json", exists: false, content: "" },
    packageLocks: { global: null, project: null },
    skills: [],
    unscannableSkills: [],
    skillLocks: {},
  };
}

function port(overrides: Pick<PiManagementPort, "availability" | "inspect">): PiManagementPort {
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by management load tests");
  };
  return {
    ...overrides,
    readSkillSource: unsupported,
    browseSkillSource: unsupported,
    mutatePackage: unsupported,
    mutateSkill: unsupported,
  };
}

function setup(factory: PiManagementPortFactory, root = "/a"): void {
  resetBackendContainerForTests();
  configureBrowserBackend({ createPiManagement: factory } as BackendPorts);
  useSessions.setState({ executionBinding: { kind: "local", targetId: "local" } });
  useWorkspace.setState({ root });
  usePiManagement.setState({
    targetKey: null,
    generation: 0,
    loading: false,
    loaded: false,
    availability: null,
    snapshot: null,
    error: null,
    dirtyTasks: {},
  });
}

test.afterEach(() => {
  resetBackendContainerForTests();
  usePiManagement.setState({
    targetKey: null,
    generation: 0,
    loading: false,
    loaded: false,
    availability: null,
    snapshot: null,
    error: null,
    dirtyTasks: {},
  });
});

test("management load coalesces direct and synchronously re-entrant callers", async () => {
  const availability = deferred<PiManagementAvailability>();
  let availabilityCalls = 0;
  let inspectCalls = 0;
  setup((_binding, root) =>
    port({
      availability: () => {
        availabilityCalls += 1;
        return availability.promise;
      },
      inspect: async () => {
        inspectCalls += 1;
        return snapshot(`local:${root ?? ""}`, "loaded");
      },
    }),
  );

  let reentrant: Promise<void> | null = null;
  const unsubscribe = usePiManagement.subscribe((state) => {
    if (state.loading && !reentrant) reentrant = state.load();
  });

  const first = usePiManagement.getState().load();
  const second = usePiManagement.getState().load();

  assert.equal(reentrant, first);
  assert.equal(second, first);
  assert.equal(availabilityCalls, 1);

  availability.resolve(readable);
  await Promise.all([first, second, reentrant]);
  unsubscribe();

  assert.equal(inspectCalls, 1);
  assert.equal(usePiManagement.getState().snapshot?.stateToken, "loaded");
});

test("management load starts a fresh request after the previous one settles", async () => {
  let availabilityCalls = 0;
  let inspectCalls = 0;
  setup((_binding, root) =>
    port({
      availability: async () => {
        availabilityCalls += 1;
        return readable;
      },
      inspect: async () => {
        inspectCalls += 1;
        return snapshot(`local:${root ?? ""}`, `refresh-${inspectCalls}`);
      },
    }),
  );

  const first = usePiManagement.getState().load();
  await first;
  const second = usePiManagement.getState().load();
  await second;

  assert.notEqual(second, first);
  assert.equal(availabilityCalls, 2);
  assert.equal(inspectCalls, 2);
  assert.equal(usePiManagement.getState().snapshot?.stateToken, "refresh-2");
});

test("management load does not revive an invalidated request after an A-B-A switch", async () => {
  const a1 = deferred<PiManagementAvailability>();
  const a2 = deferred<PiManagementAvailability>();
  const b1 = deferred<PiManagementAvailability>();
  const queues = new Map([
    ["/a", [a1, a2]],
    ["/b", [b1]],
  ]);
  const availabilityCalls = new Map<string, number>();
  const inspectCalls = new Map<string, number>();

  setup((_binding, root) => {
    const key = root ?? "";
    return port({
      availability: () => {
        availabilityCalls.set(key, (availabilityCalls.get(key) ?? 0) + 1);
        const gate = queues.get(key)?.shift();
        if (!gate) throw new Error(`missing availability gate for ${key}`);
        return gate.promise;
      },
      inspect: async () => {
        inspectCalls.set(key, (inspectCalls.get(key) ?? 0) + 1);
        return snapshot(`local:${key}`, `${key}-current`);
      },
    });
  });

  const firstA = usePiManagement.getState().load();
  useWorkspace.setState({ root: "/b" });
  const firstB = usePiManagement.getState().load();
  useWorkspace.setState({ root: "/a" });
  const secondA = usePiManagement.getState().load();

  assert.notEqual(secondA, firstA);
  assert.equal(availabilityCalls.get("/a"), 2);
  assert.equal(availabilityCalls.get("/b"), 1);

  a1.resolve(readable);
  await firstA;
  assert.equal(usePiManagement.getState().load(), secondA);

  b1.resolve(readable);
  await firstB;
  a2.resolve(readable);
  await secondA;

  assert.equal(inspectCalls.get("/a"), 1);
  assert.equal(inspectCalls.get("/b") ?? 0, 0);
  assert.equal(usePiManagement.getState().snapshot?.stateToken, "/a-current");
});

test("an authoritative mutation snapshot invalidates an older same-target load", async () => {
  const oldInspect = deferred<PiManagementSnapshot>();
  const freshInspect = deferred<PiManagementSnapshot>();
  const oldInspectStarted = deferred<void>();
  const freshInspectStarted = deferred<void>();
  let inspectCalls = 0;

  setup((_binding, root) =>
    port({
      availability: async () => readable,
      inspect: () => {
        inspectCalls += 1;
        if (inspectCalls === 1) {
          oldInspectStarted.resolve();
          return oldInspect.promise;
        }
        freshInspectStarted.resolve();
        return freshInspect.promise;
      },
    }),
    "/app",
  );

  const oldLoad = usePiManagement.getState().load();
  await oldInspectStarted.promise;

  const targetKey = "local:/app";
  assert.equal(
    usePiManagement.getState().applySnapshot(targetKey, snapshot(targetKey, "mutation")),
    true,
  );
  assert.equal(usePiManagement.getState().loading, false);
  assert.equal(usePiManagement.getState().snapshot?.stateToken, "mutation");

  const freshLoad = usePiManagement.getState().load();
  await freshInspectStarted.promise;

  oldInspect.resolve(snapshot(targetKey, "stale"));
  await oldLoad;
  assert.equal(usePiManagement.getState().load(), freshLoad);

  freshInspect.resolve(snapshot(targetKey, "fresh"));
  await freshLoad;

  assert.equal(inspectCalls, 2);
  assert.equal(usePiManagement.getState().snapshot?.stateToken, "fresh");
});
