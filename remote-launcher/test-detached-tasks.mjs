import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launcher = resolve("remote-launcher/pi-desktop-launcher");
const shell = process.env.SHELL || "sh";

/**
 * The task modes need FIFOs, `/proc`, and real POSIX signals, so the half of this
 * suite that starts a supervisor only runs where those exist. The other half —
 * status repair, stop bookkeeping, reap policy — is pure file logic over crafted
 * task directories and runs everywhere, including a Windows dev machine. Run the
 * whole suite under WSL or on the remote host to cover both.
 */
const posix = process.platform !== "win32";

function toPosixPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  return match ? `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}` : value;
}

function launcherEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...extra };
  if (process.platform !== "win32") return env;

  // MSYS sh can read fd 3, but native Windows Node cannot inherit that
  // descriptor. A test-only shim materializes the heredoc, then executes the
  // correctly translated native Node path. The launcher itself still runs through
  // its real polyglot shell preamble.
  const bin = join(home, "test-bin");
  mkdirSync(bin, { recursive: true });
  const wrapper = join(bin, "node");
  const nativeNode = toPosixPath(process.execPath).replaceAll("'", "'\\''");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'script="$HOME/.launcher-node.cjs"',
    'cat <&3 > "$script"',
    `exec '${nativeNode}' "$script"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  env.PATH = `${bin};${process.env.PATH ?? ""}`;
  return env;
}

/** Every task mode answers with exactly one JSON line and exits 0, even on failure. */
function run(home, args, options = {}) {
  const result = spawnSync(shell, [launcher, ...args], {
    encoding: "utf8",
    env: launcherEnv(home, options.env),
    input: options.input,
    timeout: options.timeout ?? 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one reply line, got: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function withHome(callback) {
  const home = mkdtempSync(join(tmpdir(), "pi-detached-"));
  try {
    return callback(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function withHomeAsync(callback) {
  const home = mkdtempSync(join(tmpdir(), "pi-detached-"));
  try {
    return await callback(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const delay = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function waitUntil(predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

/** A live attach, collecting frames as they arrive rather than after the process ends. */
function attachStream(home, payload) {
  const child = spawn(shell, [launcher, "--attach", encode({ protocolVersion: 1, ...payload })], {
    env: launcherEnv(home),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const frames = [];
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    for (;;) {
      const index = pending.indexOf("\n");
      if (index === -1) break;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.length > 0) frames.push(JSON.parse(line));
    }
  });
  return {
    child,
    frames,
    /**
     * Destroys the parent's handles as well as signalling the child. On Windows the
     * launcher runs as `sh` → native node, and killing the shell does not always
     * reap the grandchild — a leaked pipe would then keep `node --test` alive
     * forever. Prefer driving the task terminal so attach exits on its own.
     */
    close: () => {
      child.stdout.destroy();
      child.stderr.destroy();
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      child.unref();
    },
  };
}

const tasksRoot = (home) => join(home, ".pi-desktop", "tasks");
const taskDir = (home, taskId) => join(tasksRoot(home), taskId);
const encode = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64");

/** A crafted task directory, so the file-logic modes can be tested with no pi. */
function seedTask(home, taskId, patch = {}) {
  const directory = taskDir(home, taskId);
  mkdirSync(directory, { recursive: true });
  const status = {
    statusVersion: 1,
    remoteTaskId: taskId,
    previousTaskId: null,
    state: "running",
    // Deliberately unallocatable: a pid this high is not running, which is exactly
    // the "status.json says running, nothing is" case the modes must detect.
    pid: 999_999_998,
    supervisorPid: 999_999_999,
    startedAt: Date.now() - 1_000,
    updatedAt: Date.now(),
    exitCode: null,
    exitSignal: null,
    stopRequestedAt: null,
    stopConfirmedAt: null,
    cwd: "/tmp",
    piExecutable: "pi",
    resumePath: null,
    journal: {
      liveSegment: "events-000000000001.jsonl",
      baseSequence: 1,
      liveBaseSequence: 1,
      nextSequence: 1,
      totalBytes: 0,
    },
    ...patch,
  };
  writeFileSync(join(directory, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  return directory;
}

function readJournal(home, taskId) {
  const directory = taskDir(home, taskId);
  return readdirSync(directory)
    .filter((name) => /^events-\d{12}\.jsonl$/.test(name))
    .sort()
    .flatMap((name) => readFileSync(join(directory, name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line));
}

function writeFakePi(home, body) {
  const target = join(home, "fake-pi");
  writeFileSync(target, `#!/bin/sh\n${body}\n`);
  chmodSync(target, 0o700);
  return target;
}

const segmentFile = (base) => `events-${String(base).padStart(12, "0")}.jsonl`;

/**
 * Attach is a pure reader, so replay can be tested against a crafted journal with no
 * supervisor and no pi — which is what makes the cursor and snapshot-window rules
 * testable on any platform.
 */
function seedJournal(home, taskId, segments) {
  const directory = taskDir(home, taskId);
  let totalBytes = 0;
  let nextSequence = 1;
  for (const segment of segments) {
    const body = segment.lines.map((record) => `${JSON.stringify(record)}\n`).join("");
    writeFileSync(join(directory, segmentFile(segment.base)), body);
    totalBytes += Buffer.byteLength(body);
    nextSequence = segment.base + segment.lines.length;
  }
  const live = segments.at(-1);
  return {
    liveSegment: segmentFile(live.base),
    baseSequence: segments[0].base,
    liveBaseSequence: live.base,
    nextSequence,
    totalBytes,
  };
}

const stdoutRecord = (text) => ({ ts: 1_700_000_000_000, stream: "stdout", data: text });

function attach(home, payload, options = {}) {
  const result = spawnSync(shell, [launcher, "--attach", encode({ protocolVersion: 1, ...payload })], {
    encoding: "utf8",
    env: launcherEnv(home),
    timeout: options.timeout ?? 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  return result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function startDetached(home, taskId, piExecutable, extra = {}) {
  return run(home, ["--start-detached", encode({
    protocolVersion: 1,
    cwd: home,
    piExecutable,
    resumePath: null,
    remoteTaskId: taskId,
    ...extra,
  })], { timeout: 40_000 });
}

function waitFor(home, taskId, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = run(home, ["--status", taskId]);
    if (last.ok && predicate(last.task)) return last.task;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 100);
  }
  throw new Error(`task never satisfied predicate: ${JSON.stringify(last)}`);
}

test("the capability handshake advertises detached tasks", () => {
  withHome((home) => {
    const reply = run(home, ["--capabilities"]);
    assert.equal(reply.launcherProtocolVersion, 1);
    assert.ok(reply.capabilities.includes("detached-tasks-v1"));
    assert.ok(reply.capabilities.includes("attach-v1"));
    // Capabilities are additive and independently versioned: the V1 surface must
    // still be advertised, or every already-installed desktop loses it.
    for (const capability of ["run-v1", "preflight-v1", "provider-sync-v1", "capabilities-v1"]) {
      assert.ok(reply.capabilities.includes(capability), capability);
    }
    // Not advertised: it is how the launcher re-enters itself, not a desktop call.
    assert.equal(reply.capabilities.includes("supervise-v1"), false);
  });
});

test("an empty host lists no tasks instead of failing", () => {
  withHome((home) => {
    assert.deepEqual(run(home, ["--status"]), { ok: true, tasks: [] });
  });
});

test("failures are loud on both channels, never silent", () => {
  withHome((home) => {
    // A status probe that answered failure with silence would be
    // indistinguishable from a host that genuinely has no tasks.
    assert.deepEqual(run(home, ["--status", "missing-task"]), { ok: false, errorCode: "taskNotFound" });
    assert.deepEqual(run(home, ["--status", "BAD"]), { ok: false, errorCode: "taskIdInvalid" });
    assert.deepEqual(run(home, ["--stop", "sh0rt"]), { ok: false, errorCode: "taskIdInvalid" });
    assert.deepEqual(run(home, ["--stop", "missing-task"]), { ok: false, errorCode: "taskNotFound" });
    assert.deepEqual(run(home, ["--send", "missing-task"], { input: "" }), {
      ok: false,
      errorCode: "taskNotFound",
    });
  });
});

test("--supervise refuses to run unless --start-detached invoked it", () => {
  withHome((home) => {
    const reply = run(home, ["--supervise", encode({
      protocolVersion: 1,
      cwd: "/tmp",
      piExecutable: "pi",
      resumePath: null,
      remoteTaskId: "task-0001",
    })]);
    assert.deepEqual(reply, { ok: false, errorCode: "supervisorNotInvokable" });
  });
});

test("start payloads are validated before any directory is created", () => {
  withHome((home) => {
    const cases = [
      [{ protocolVersion: 2, cwd: "/tmp", piExecutable: "pi", remoteTaskId: "task-0001" }, "taskPayloadInvalid"],
      [{ protocolVersion: 1, cwd: "relative", piExecutable: "pi", remoteTaskId: "task-0001" }, "taskPayloadInvalid"],
      [{ protocolVersion: 1, cwd: "/tmp", piExecutable: "", remoteTaskId: "task-0001" }, "taskPayloadInvalid"],
      [{ protocolVersion: 1, cwd: "/tmp", piExecutable: "pi", remoteTaskId: "No" }, "taskIdInvalid"],
      [{ protocolVersion: 1, cwd: "/tmp", piExecutable: "pi" }, "taskIdInvalid"],
    ];
    for (const [payload, errorCode] of cases) {
      assert.deepEqual(
        run(home, ["--start-detached", encode(payload)]),
        { ok: false, errorCode },
        JSON.stringify(payload),
      );
    }
    assert.deepEqual(run(home, ["--status"]), { ok: true, tasks: [] });
  });
});

test("a status file describing a dead supervisor is reported as exited and stale", () => {
  withHome((home) => {
    seedTask(home, "task-dead1");
    const first = run(home, ["--status", "task-dead1"]);
    assert.equal(first.task.state, "exited");
    assert.equal(first.task.stale, true);
    assert.equal(first.task.exitCode, null);
    // The repair is persisted, and an unwitnessed death stays unwitnessed: a
    // second poll must not read as a clean exit.
    const persisted = JSON.parse(readFileSync(join(taskDir(home, "task-dead1"), "status.json"), "utf8"));
    assert.equal(persisted.state, "exited");
    assert.equal(persisted.stale, true);
    assert.equal(run(home, ["--status", "task-dead1"]).task.stale, true);
  });
});

test("stopping a task whose supervisor is already gone repairs it instead of hanging", () => {
  withHome((home) => {
    seedTask(home, "task-dead2");
    const reply = run(home, ["--stop", "task-dead2"]);
    assert.equal(reply.ok, true);
    assert.equal(reply.alreadyStopped, true);
    assert.equal(reply.task.state, "exited");
    assert.equal(reply.task.stale, true);
  });
});

test("stopping a terminal task is idempotent and returns its recorded outcome", () => {
  withHome((home) => {
    seedTask(home, "task-done1", {
      state: "exited",
      exitCode: 7,
      stopRequestedAt: 1_000,
      stopConfirmedAt: 4_400,
      pid: null,
      supervisorPid: null,
    });
    for (const attempt of [1, 2]) {
      const reply = run(home, ["--stop", "task-done1"]);
      assert.equal(reply.alreadyStopped, true, `attempt ${attempt}`);
      assert.equal(reply.task.exitCode, 7);
      // Both timestamps survive, because they were measured 17x apart: the ack
      // proves generation stopped, process death proves the session file went.
      assert.equal(reply.task.stopRequestedAt, 1_000);
      assert.equal(reply.task.stopConfirmedAt, 4_400);
      assert.equal(reply.task.stale, false);
    }
  });
});

test("--send refuses a task that is not running", () => {
  withHome((home) => {
    seedTask(home, "task-done2", { state: "exited", exitCode: 0, pid: null, supervisorPid: null });
    assert.deepEqual(run(home, ["--send", "task-done2"], { input: '{"type":"prompt"}\n' }), {
      ok: false,
      errorCode: "taskNotRunning",
      detail: "exited",
    });
  });
});

test("--reap repairs stale tasks, drops idle ones, and never touches a live one", () => {
  withHome((home) => {
    const idle = Date.now() - 7 * 60 * 60 * 1000;
    seedTask(home, "task-idle1", { state: "exited", exitCode: 0, updatedAt: idle, pid: null, supervisorPid: null });
    seedTask(home, "task-recent", { state: "exited", exitCode: 0, pid: null, supervisorPid: null });
    seedTask(home, "task-stale1");
    // A live supervisor: this process. Reap must leave it completely alone.
    seedTask(home, "task-live01", { supervisorPid: process.pid, pid: process.pid });
    const reply = run(home, ["--reap"]);
    assert.equal(reply.ok, true);
    assert.equal(reply.repaired, 1, "the stale task is the only one needing repair");
    assert.ok(reply.removed >= 1, "the 7h-idle terminal task is past the 6h TTL");
    const ids = run(home, ["--status"]).tasks.map((task) => task.remoteTaskId);
    assert.equal(ids.includes("task-idle1"), false);
    assert.ok(ids.includes("task-recent"));
    assert.ok(ids.includes("task-live01"));
    assert.equal(run(home, ["--status", "task-live01"]).task.state, "running");
  });
});

test("a task directory with no readable status is removed rather than left orphaned", () => {
  withHome((home) => {
    mkdirSync(taskDir(home, "task-empty1"), { recursive: true });
    assert.equal(run(home, ["--reap"]).removed, 1);
    assert.deepEqual(run(home, ["--status"]), { ok: true, tasks: [] });
  });
});

test("the per-host task limit is enforced before anything is spawned", () => {
  withHome((home) => {
    for (let index = 0; index < 8; index += 1) {
      seedTask(home, `task-live${String(index).padStart(2, "0")}`, {
        supervisorPid: process.pid,
        pid: process.pid,
      });
    }
    const reply = run(home, ["--start-detached", encode({
      protocolVersion: 1,
      cwd: "/tmp",
      piExecutable: "pi",
      resumePath: null,
      remoteTaskId: "task-over01",
    })]);
    assert.equal(reply.ok, false);
    assert.equal(reply.errorCode, "taskLimitReached");
    assert.equal(readdirSync(tasksRoot(home)).includes("task-over01"), false);
  });
});

test("a symlinked task root is refused instead of followed", { skip: !posix }, () => {
  withHome((home) => {
    const elsewhere = mkdtempSync(join(tmpdir(), "pi-detached-target-"));
    try {
      mkdirSync(join(home, ".pi-desktop"), { recursive: true });
      symlinkSync(elsewhere, tasksRoot(home), "dir");
      const reply = run(home, ["--start-detached", encode({
        protocolVersion: 1,
        cwd: "/tmp",
        piExecutable: "pi",
        resumePath: null,
        remoteTaskId: "task-link01",
      })]);
      assert.deepEqual(
        { ok: reply.ok, errorCode: reply.errorCode },
        { ok: false, errorCode: "taskSymlinkRejected" },
      );
      assert.equal(readdirSync(elsewhere).length, 0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test("a detached task journals both streams with a tag and survives its starter", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, [
      "printf '%s\\n' '{\"type\":\"ready\"}'",
      "printf '%s\\n' 'boot diagnostic' >&2",
      "exec sleep 30",
    ].join("\n"));
    const started = startDetached(home, "task-jrnl01", pi);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.ok(Number.isInteger(started.pid));
    assert.ok(Number.isInteger(started.supervisorPid));
    assert.notEqual(started.pid, started.supervisorPid);
    // The starter has already exited by now — that is the whole point.
    const task = waitFor(home, "task-jrnl01", (current) => (current.journal?.nextSequence ?? 0) >= 3);
    assert.equal(task.state, "running");
    assert.equal(task.stale, false);

    const records = readJournal(home, "task-jrnl01");
    assert.equal(records[0].stream, "control");
    assert.equal(records[0].event, "started");
    // stderr was 0 bytes in every acceptance scenario and pi's protocol errors
    // arrive on stdout, so one ordered journal with a stream tag beats two files.
    const stdout = records.filter((record) => record.stream === "stdout");
    const stderr = records.filter((record) => record.stream === "stderr");
    assert.deepEqual(stdout.map((record) => record.data), ['{"type":"ready"}']);
    assert.deepEqual(stderr.map((record) => record.data), ["boot diagnostic"]);
    // sequence is the line number, not a field: it must never appear in a record.
    assert.equal(Object.hasOwn(records[0], "seq"), false);
    assert.equal(task.journal.baseSequence, 1);
    assert.equal(task.journal.liveSegment, "events-000000000001.jsonl");

    const stopped = run(home, ["--stop", "task-jrnl01"]);
    assert.equal(stopped.task.state, "exited");
    assert.ok(stopped.task.stopRequestedAt > 0, "the ack timestamp is recorded");
    assert.ok(stopped.task.stopConfirmedAt >= stopped.task.stopRequestedAt,
      "process death is recorded separately from the ack");
    assert.equal(stopped.task.stale, false, "a witnessed stop is not a stale death");
    const terminal = readJournal(home, "task-jrnl01");
    assert.deepEqual(
      terminal.filter((record) => record.stream === "control").map((record) => record.event),
      ["started", "stop_requested", "exited"],
    );
  });
});

test("a task id is never reused, so a sequence gap can only mean a disconnect", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, "exec sleep 30");
    assert.equal(startDetached(home, "task-once01", pi).ok, true);
    const again = startDetached(home, "task-once01", pi);
    assert.deepEqual({ ok: again.ok, errorCode: again.errorCode }, { ok: false, errorCode: "taskAlreadyRunning" });
    run(home, ["--stop", "task-once01"]);
    // Still refused after it has exited: continuing means a new id with
    // previousTaskId set, never a second pi over the same journal.
    const afterExit = startDetached(home, "task-once01", pi);
    assert.equal(afterExit.errorCode, "taskAlreadyRunning");
  });
});

test("SIGHUP does not kill a detached task", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, "exec sleep 30");
    const started = startDetached(home, "task-hup001", pi);
    assert.equal(started.ok, true, JSON.stringify(started));
    // Run mode forwards SIGHUP to its pi child, and that forwarding is exactly
    // what makes an attached task die with its channel. A detached task inverts it.
    process.kill(started.supervisorPid, "SIGHUP");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(wait, 0, 0, 700);
    const task = run(home, ["--status", "task-hup001"]).task;
    assert.equal(task.state, "running");
    assert.equal(task.piAlive, true);
    // SIGTERM still means a deliberate stop.
    assert.equal(run(home, ["--stop", "task-hup001"]).task.state, "exited");
  });
});

test("--send reaches pi's stdin through the FIFO", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, 'while IFS= read -r line; do printf "%s\\n" "echo:$line"; done');
    const started = startDetached(home, "task-send01", pi);
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.stdinReady, true);
    const sent = run(home, ["--send", "task-send01"], { input: '{"type":"prompt"}\n' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(sent.bytes, 18);
    waitFor(home, "task-send01", () => readJournal(home, "task-send01")
      .some((record) => record.stream === "stdout" && record.data === 'echo:{"type":"prompt"}'));
    // The writer lock is released, so a second send is not blocked by the first.
    assert.equal(run(home, ["--send", "task-send01"], { input: "second\n" }).ok, true);
    run(home, ["--stop", "task-send01"]);
  });
});

test("a pi exit code is recorded without a stop request", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, "printf '%s\\n' '{\"type\":\"bye\"}'\nexit 7");
    const started = startDetached(home, "task-exit01", pi);
    // A pi that exits inside the start window still started: only the supervisor's
    // own errorCode means it never got off the ground.
    assert.equal(started.ok, true, JSON.stringify(started));
    const task = waitFor(home, "task-exit01", (current) => current.state === "exited");
    assert.equal(task.exitCode, 7);
    assert.equal(task.stale, false, "a witnessed exit is not stale");
    assert.equal(task.stopRequestedAt, null);
    assert.equal(task.stopConfirmedAt, null, "nothing asked it to stop, so nothing confirms one");
    const records = readJournal(home, "task-exit01");
    assert.deepEqual(records.at(-1), {
      ...records.at(-1),
      stream: "control",
      event: "exited",
      exitCode: 7,
      exitSignal: null,
    });
  });
});

test("an unusable pi executable fails the start instead of reporting running", { skip: !posix }, () => {
  withHome((home) => {
    const reply = startDetached(home, "task-nopi01", join(home, "not-installed"));
    assert.equal(reply.ok, false);
    assert.equal(reply.errorCode, "piStartFailed");
    assert.equal(run(home, ["--status", "task-nopi01"]).task.state, "exited");
  });
});

test("a line past the event cap is stored truncated rather than dropped", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, [
      "head -c 1200000 /dev/zero | tr '\\0' 'x'",
      "printf '\\n'",
      "exec sleep 30",
    ].join("\n"));
    const started = startDetached(home, "task-long01", pi);
    assert.equal(started.ok, true, JSON.stringify(started));
    waitFor(home, "task-long01", () => readJournal(home, "task-long01")
      .some((record) => record.truncated === true), 20_000);
    const truncated = readJournal(home, "task-long01").find((record) => record.truncated === true);
    // Caps are byte-based: an 8513-char JSONL line is legitimate, so the bound sits
    // far above it and only a runaway line is cut.
    assert.equal(truncated.data.length, 1024 * 1024);
    assert.equal(truncated.stream, "stdout");
    run(home, ["--stop", "task-long01"]);
  });
});

test("attach validates its payload and refuses an unknown task", () => {
  withHome((home) => {
    for (const payload of [
      { remoteTaskId: "task-0001", after: -1 },
      { remoteTaskId: "task-0001", after: 1.5 },
      { remoteTaskId: "task-0001", follow: "yes" },
      { protocolVersion: 2, remoteTaskId: "task-0001" },
    ]) {
      const frames = attach(home, payload);
      assert.deepEqual(frames, [{ ok: false, errorCode: "attachPayloadInvalid" }], JSON.stringify(payload));
    }
    assert.deepEqual(attach(home, { remoteTaskId: "BAD" }), [{ ok: false, errorCode: "taskIdInvalid" }]);
    assert.deepEqual(attach(home, { remoteTaskId: "task-0001" }), [{ ok: false, errorCode: "taskNotFound" }]);
  });
});

test("attach replays a terminal task in order and reports why it detached", () => {
  withHome((home) => {
    seedTask(home, "task-play01");
    const journal = seedJournal(home, "task-play01", [{
      base: 1,
      lines: [
        { ts: 1, stream: "control", event: "started", pid: 1, supervisorPid: 2 },
        stdoutRecord('{"type":"ready"}'),
        { ts: 3, stream: "stderr", data: "boot diagnostic" },
        { ts: 4, stream: "control", event: "exited", exitCode: 0, exitSignal: null },
      ],
    }]);
    seedTask(home, "task-play01", {
      state: "exited", exitCode: 0, pid: null, supervisorPid: null, journal,
    });
    const frames = attach(home, { remoteTaskId: "task-play01" });
    assert.deepEqual(frames[0], {
      type: "attached",
      remoteTaskId: "task-play01",
      state: "exited",
      after: null,
      baseSequence: 1,
      nextSequence: 5,
      snapshotRequired: false,
      pid: null,
      supervisorPid: null,
    });
    const events = frames.filter((frame) => frame.type === "event");
    // sequence is the journal line number, assigned by the reader, never a field in
    // the record itself.
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.map((event) => event.stream), ["control", "stdout", "stderr", "control"]);
    assert.equal(events[1].data, '{"type":"ready"}');
    assert.deepEqual(frames.at(-1), {
      type: "detached", reason: "taskExited", exitCode: 0, nextSequence: 5,
    });
  });
});

test("an after cursor emits strictly later records and follow:false stops at the end", () => {
  withHome((home) => {
    seedTask(home, "task-curs01");
    const journal = seedJournal(home, "task-curs01", [
      { base: 1, lines: [stdoutRecord("one"), stdoutRecord("two")] },
      { base: 3, lines: [stdoutRecord("three"), stdoutRecord("four")] },
    ]);
    seedTask(home, "task-curs01", { supervisorPid: process.pid, pid: process.pid, journal });
    const frames = attach(home, { remoteTaskId: "task-curs01", after: 2, follow: false });
    const events = frames.filter((frame) => frame.type === "event");
    assert.deepEqual(events.map((event) => [event.sequence, event.data]), [[3, "three"], [4, "four"]]);
    // A running task with follow:false detaches as soon as it is drained; only an
    // actually terminal task reports taskExited.
    assert.deepEqual(frames.at(-1), {
      type: "detached", reason: "caughtUp", exitCode: null, nextSequence: 5,
    });
    // Crossing a segment boundary must not skip or repeat a record.
    assert.deepEqual(
      attach(home, { remoteTaskId: "task-curs01", follow: false })
        .filter((frame) => frame.type === "event")
        .map((event) => event.sequence),
      [1, 2, 3, 4],
    );
  });
});

test("a cursor older than the retained window asks for a snapshot instead of lying", () => {
  withHome((home) => {
    seedTask(home, "task-snap01");
    // Segments 1-99 were evicted by the byte cap; the journal now starts at 100.
    const journal = seedJournal(home, "task-snap01", [
      { base: 100, lines: [stdoutRecord("hundred"), stdoutRecord("hundred-one")] },
    ]);
    seedTask(home, "task-snap01", { supervisorPid: process.pid, pid: process.pid, journal });

    // after + 1 < baseSequence: the record right after the cursor is gone, so the
    // desktop cannot know what it missed.
    const stale = attach(home, { remoteTaskId: "task-snap01", after: 42, follow: false });
    assert.equal(stale[0].snapshotRequired, true);
    assert.equal(stale[0].baseSequence, 100);
    // Streaming still resumes from the window, so a stale cursor recovers a live view
    // — it just has to discard its transcript first.
    assert.deepEqual(
      stale.filter((frame) => frame.type === "event").map((event) => event.sequence),
      [100, 101],
    );
    // Consumes no sequence space and mutates nothing: the same cursor gets the same
    // answer on every retry.
    const again = attach(home, { remoteTaskId: "task-snap01", after: 42, follow: false });
    assert.deepEqual(again, stale);

    // The boundary case is not outside the window: after=99 asks for 100, which is
    // exactly what is retained.
    const boundary = attach(home, { remoteTaskId: "task-snap01", after: 99, follow: false });
    assert.equal(boundary[0].snapshotRequired, false);
    assert.deepEqual(
      boundary.filter((frame) => frame.type === "event").map((event) => event.sequence),
      [100, 101],
    );
  });
});

test("eviction under a live attach reports a gap rather than a silent jump", async () => {
  await withHomeAsync(async (home) => {
    seedTask(home, "task-gap001");
    const journal = seedJournal(home, "task-gap001", [
      { base: 1, lines: [stdoutRecord("one"), stdoutRecord("two")] },
    ]);
    // A live supervisor — this process — so the attach follows instead of detaching.
    seedTask(home, "task-gap001", { supervisorPid: process.pid, pid: process.pid, journal });
    const stream = attachStream(home, { remoteTaskId: "task-gap001" });
    try {
      await waitUntil(
        () => stream.frames.filter((frame) => frame.type === "event").length === 2,
        "the retained records",
      );
      // The byte cap dropped the segment the reader was on, and the journal now
      // starts far ahead of it.
      writeFileSync(
        join(taskDir(home, "task-gap001"), segmentFile(900)),
        `${JSON.stringify(stdoutRecord("nine-hundred"))}\n`,
      );
      unlinkSync(join(taskDir(home, "task-gap001"), segmentFile(1)));
      await waitUntil(() => stream.frames.some((frame) => frame.type === "gap"), "the gap frame");
      const gap = stream.frames.find((frame) => frame.type === "gap");
      assert.deepEqual(gap, { type: "gap", fromSequence: 3, toSequence: 899 });
      await waitUntil(
        () => stream.frames.some((frame) => frame.sequence === 900),
        "the record after the gap",
      );
      assert.equal(stream.frames.at(-1).data, "nine-hundred");
      // Let the attach end on its own rather than leaking a polling child: a
      // terminal status is the normal way this channel closes.
      seedTask(home, "task-gap001", {
        state: "exited", exitCode: 0, pid: null, supervisorPid: null,
        journal: { ...journal, baseSequence: 900, liveBaseSequence: 900, nextSequence: 901 },
      });
      await waitUntil(() => stream.frames.some((frame) => frame.type === "detached"), "the detach frame");
      assert.equal(stream.frames.at(-1).reason, "taskExited");
    } finally {
      stream.close();
    }
  });
});

test("a reaped task ends the attach instead of spinning on a missing segment", async () => {
  await withHomeAsync(async (home) => {
    seedTask(home, "task-reap01");
    const journal = seedJournal(home, "task-reap01", [{ base: 1, lines: [stdoutRecord("one")] }]);
    seedTask(home, "task-reap01", { supervisorPid: process.pid, pid: process.pid, journal });
    const stream = attachStream(home, { remoteTaskId: "task-reap01" });
    try {
      await waitUntil(() => stream.frames.some((frame) => frame.sequence === 1), "the first record");
      rmSync(taskDir(home, "task-reap01"), { recursive: true, force: true });
      await waitUntil(() => stream.frames.some((frame) => frame.type === "detached"), "the detach frame");
      assert.equal(stream.frames.at(-1).reason, "taskGone");
      // One gap frame per poll would be the failure mode here.
      assert.ok(stream.frames.filter((frame) => frame.type === "gap").length <= 1);
    } finally {
      stream.close();
    }
  });
});

test("attach streams records while the task is still running", { skip: !posix }, async () => {
  await withHomeAsync(async (home) => {
    const pi = writeFakePi(home, 'while IFS= read -r line; do printf "%s\\n" "echo:$line"; done');
    const started = startDetached(home, "task-tail01", pi);
    assert.equal(started.ok, true, JSON.stringify(started));
    const stream = attachStream(home, { remoteTaskId: "task-tail01" });
    try {
      await waitUntil(() => stream.frames.some((frame) => frame.type === "attached"), "the handshake");
      assert.equal(stream.frames[0].state, "running");
      assert.equal(stream.frames[0].snapshotRequired, false);
      // Written after the attach opened, so this can only have arrived by tailing.
      assert.equal(run(home, ["--send", "task-tail01"], { input: '{"type":"prompt"}\n' }).ok, true);
      await waitUntil(
        () => stream.frames.some((frame) => frame.data === 'echo:{"type":"prompt"}'),
        "the echoed prompt",
      );
      const sequences = stream.frames.filter((frame) => frame.type === "event").map((frame) => frame.sequence);
      assert.deepEqual(sequences, sequences.map((_, index) => index + 1), "sequences are gapless");
      run(home, ["--stop", "task-tail01"]);
      await waitUntil(() => stream.frames.some((frame) => frame.type === "detached"), "the detach frame");
      const detached = stream.frames.at(-1);
      assert.equal(detached.reason, "taskExited");
      // The exit record is the last thing the supervisor writes, so a reader that
      // stopped at the terminal status would have lost it.
      assert.equal(
        stream.frames.filter((frame) => frame.event === "exited").length,
        1,
        "the terminal control record was delivered before detaching",
      );
    } finally {
      stream.close();
    }
  });
});

test("a keyed send is applied once however many times it is retried", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, 'while IFS= read -r line; do printf "%s\\n" "echo:$line"; done');
    assert.equal(startDetached(home, "task-idem01", pi).ok, true);
    const envelope = (message) =>
      `${JSON.stringify({ idempotencyKey: "k-abc123", payload: `{"m":"${message}"}\n` })}\n`;

    const first = run(home, ["--send", "task-idem01"], { input: envelope("one") });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.duplicate, false);
    assert.equal(first.idempotencyKey, "k-abc123");

    // A disconnect at 24s tells the desktop nothing about whether the write landed.
    // Retrying with the same key must not duplicate the turn.
    const retry = run(home, ["--send", "task-idem01"], { input: envelope("one") });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.sentAt, first.sentAt, "the recorded outcome is returned, not a new one");
    assert.equal(retry.bytes, first.bytes);

    // The same key with a different payload is a bug in the caller, not a retry.
    assert.deepEqual(run(home, ["--send", "task-idem01"], { input: envelope("two") }), {
      ok: false,
      errorCode: "sendIdempotencyConflict",
      detail: "k-abc123",
    });

    waitFor(home, "task-idem01", () => readJournal(home, "task-idem01")
      .some((record) => record.data === 'echo:{"m":"one"}'));
    const echoes = readJournal(home, "task-idem01").filter((record) => record.data === 'echo:{"m":"one"}');
    assert.equal(echoes.length, 1, "pi saw the message exactly once");
    assert.equal(
      readJournal(home, "task-idem01").some((record) => record.data?.includes('"two"')),
      false,
      "the conflicting payload was never forwarded",
    );
    run(home, ["--stop", "task-idem01"]);
  });
});

test("an unkeyed send is still forwarded verbatim", { skip: !posix }, () => {
  withHome((home) => {
    const pi = writeFakePi(home, 'while IFS= read -r line; do printf "%s\\n" "echo:$line"; done');
    assert.equal(startDetached(home, "task-bare01", pi).ok, true);
    // A bare pi command is also a JSON object, so the envelope is recognised only by
    // its exact shape — this must not be read as one.
    const reply = run(home, ["--send", "task-bare01"], { input: '{"type":"prompt","idempotency":"no"}\n' });
    assert.equal(reply.ok, true);
    assert.equal(reply.duplicate, undefined);
    waitFor(home, "task-bare01", () => readJournal(home, "task-bare01")
      .some((record) => record.data === 'echo:{"type":"prompt","idempotency":"no"}'));
    run(home, ["--stop", "task-bare01"]);
  });
});


