#!/usr/bin/env node
/**
 * Remote Agent V1 acceptance harness — see docs/remote-agent-v1-acceptance.md.
 *
 * Drives the *real* launcher over the *real* SSH policy so the numbers recorded
 * are the numbers the app produces. It deliberately does not import from src/:
 * the point is to observe the shipped contract from outside, and a shared helper
 * would let a bug in the app hide itself in the measurement.
 *
 * Usage:
 *   node scripts/remote-agent-acceptance.mjs <scenario> [--host alias] [--json]
 *
 * Scenarios that need a model turn are not implemented: pi on the target has no
 * credentials (`piAuthConfigured: false`), and process lifecycle — which is what
 * the V2 status state machine is designed from — does not require one.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const scenario = args.find((a) => !a.startsWith("--")) ?? "";
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const HOST = flag("host", "yuyun");
const CWD = flag("cwd", "/root/turb-gpt-free-register");
const LAUNCHER = flag("launcher", "/root/.local/bin/pi-desktop-launcher");
const PI = flag("pi", "pi");
const asJson = args.includes("--json");

/** The app's fixed SSH policy, including the Phase 0.1 liveness probe. */
const SSH_OPTIONS = [
  "-T",
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "KbdInteractiveAuthentication=no",
  "-o", "PasswordAuthentication=no",
  "-o", "NumberOfPasswordPrompts=0",
  "-o", "ForwardAgent=no",
  "-o", "ForwardX11=no",
  "-o", "ClearAllForwardings=yes",
  "-o", "PermitLocalCommand=no",
  "-o", "RemoteCommand=none",
  "-o", "EscapeChar=none",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  "-o", "RequestTTY=no",
];

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const payload = (overrides = {}) =>
  Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      cwd: CWD,
      piExecutable: PI,
      resumePath: null,
      ...overrides,
    }),
  ).toString("base64");

/**
 * A side-channel SSH session, so probing never disturbs the measured one.
 * Throws rather than returning empty: a silently failed probe reads exactly like
 * "no remote processes", which is the one answer this harness must never invent.
 */
function probe(remoteScript) {
  const result = spawnSync("ssh", [...SSH_OPTIONS, HOST, remoteScript], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw new Error(`probe could not run: ${result.error.message}`);
  if (result.status !== 0 && !(result.stdout ?? "").trim()) {
    const detail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(`probe exited ${result.status}: ${detail}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Identifying the remote processes is itself an acceptance finding.
 *
 * Pi rewrites its argv to a bare `pi` — the `--mode rpc` the launcher passes
 * never appears in `/proc/<pid>/cmdline`. So `pgrep -f 'pi --mode rpc'` matches
 * nothing even while pi is answering RPC, and any reaper that identifies a pi by
 * its command line is blind. The launcher is found by its own environment
 * variable instead, and pi as its child.
 */
const REMOTE_STATE = [
  // Everything carrying PI_DESKTOP_LAUNCHER_MODE. Pi inherits the launcher's
  // environment, so this set holds both and must be split by `comm`: the
  // launcher runs as `node`, pi as `pi`.
  'launchers=""; pis=""',
  "for e in /proc/[0-9]*/environ; do",
  '  [ -r "$e" ] || continue',
  '  p=${e#/proc/}; p=${p%/environ}',
  // `grep -a` on the raw NUL-separated file. Translating NULs with `tr` would
  // need a literal NUL in argv, which Node refuses to pass at all.
  '  grep -qa "PI_DESKTOP_LAUNCHER_MODE=" "$e" 2>/dev/null || continue',
  '  c=$(ps -o comm= -p "$p" 2>/dev/null | tr -d " ")',
  '  if [ "$c" = "pi" ]; then pis="$pis$p,"; else launchers="$launchers$p,"; fi',
  "done",
  // An orphaned pi outlives its launcher's environment view only if the process
  // itself is gone, so also sweep by exact name.
  'for o in $(pgrep -x pi 2>/dev/null); do',
  '  case ",$pis," in *",$o,"*) ;; *) pis="$pis$o," ;; esac',
  "done",
  'echo "launcher:$launchers"',
  'echo "pi:$pis"',
  'for p in $(echo "$pis" | tr "," " "); do',
  '  echo "detail:$p:$(ps -o ppid=,stat=,comm= -p "$p" 2>/dev/null | tr -s " ")"',
  "done",
  // Newlines, not "; ": joining with semicolons produces `do;` and `then;`,
  // which are syntax errors. Newlines separate shell statements correctly and
  // survive being passed as one argv element.
].join("\n");

function remoteState() {
  const out = probe(REMOTE_STATE);
  const pick = (key) =>
    (out.split("\n").find((l) => l.startsWith(`${key}:`)) ?? "")
      .slice(key.length + 1)
      .split(",")
      .filter(Boolean);
  return {
    piPids: pick("pi"),
    launcherPids: pick("launcher"),
    details: out
      .split("\n")
      .filter((l) => l.startsWith("detail:"))
      .map((l) => l.slice("detail:".length).trim()),
  };
}

/** The journal, decoded. Each call is one ssh round trip, so callers poll it sparingly. */
function readJournal(run, taskId) {
  const attach = run(
    `'--attach' ${shellQuote(
      Buffer.from(JSON.stringify({ protocolVersion: 1, remoteTaskId: taskId, follow: false })).toString("base64"),
    )}`,
  );
  return attach
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((frame) => frame.type === "event");
}

/**
 * Polls the journal until `done`. Not a stream: `--attach --follow` would hold the
 * channel open, and this harness measures one round trip at a time on purpose.
 */
async function waitForJournal(run, taskId, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let records = [];
  while (Date.now() < deadline) {
    records = readJournal(run, taskId);
    if (done(records)) return records;
    await sleep(1500);
  }
  throw new Error(`journal never satisfied the predicate (${records.length} records)`);
}

/** `set_model` through the FIFO, then confirm pi acknowledged it in the journal. */
async function selectModelDetached(run, taskId) {
  const before = readJournal(run, taskId).length;
  const request = JSON.stringify({ type: "set_model", id: "sel", provider: MODEL_PROVIDER, modelId: MODEL_ID });
  probe(
    `printf %s ${shellQuote(`${request}
`)} | ` +
      `sh ${shellQuote("/tmp/pi-detached-acceptance/launcher")} '--send' ${shellQuote(taskId)}`,
  );
  await waitForJournal(
    run,
    taskId,
    (records) =>
      records.slice(before).some(
        (r) => r.stream === "stdout" && /"command"s*:s*"set_model"/.test(r.data ?? ""),
      ),
    60_000,
  );
}

const MODEL_PROVIDER = flag("provider", "novol");
const MODEL_ID = flag("model", "gpt-5.6-sol");

/** Starts `--run` and resolves once pi answers `get_state`, so timing starts from a live turn-capable process. */
function startRun(extraSshOptions = []) {
  const child = spawn(
    "ssh",
    [...SSH_OPTIONS, ...extraSshOptions, HOST, `${shellQuote(LAUNCHER)} '--run' '${payload()}'`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const record = { stdout: "", stderr: "", exitCode: null, signal: null, exitedAt: null };
  child.stdout.on("data", (c) => (record.stdout += c.toString()));
  child.stderr.on("data", (c) => (record.stderr += c.toString()));
  const exited = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      record.exitCode = code;
      record.signal = signal;
      record.exitedAt = Date.now();
      resolve(record);
    }),
  );
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pi did not answer get_state in 60s")), 60_000);
    const check = () => {
      if (record.stdout.includes('"command":"get_state"')) {
        clearTimeout(timer);
        child.stdout.off("data", check);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error(`ssh closed before pi was ready (code ${record.exitCode})`));
    });
  });
  child.stdin.write('{"type":"get_state","id":"ready"}\n');
  return { child, record, exited, ready };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parsed JSONL events seen so far on a run's stdout. */
function events(record) {
  return record.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Assistant text from either shape pi produces.
 *
 * Streaming is not guaranteed: the same prompt to the same model sometimes
 * arrives as `assistantMessageEvent: text_delta` events and sometimes only as
 * the finished text inside `message_end` / `turn_end`, where `message_update`
 * carries nothing but `usage`. Reading deltas alone silently reports an empty
 * response for the non-streaming shape.
 */
function assistantText(record) {
  const list = events(record);
  const deltas = list
    .map((e) => e.assistantMessageEvent)
    .filter((ev) => ev?.type === "text_delta" && ev.delta)
    .map((ev) => ev.delta)
    .join("");
  if (deltas) return deltas;
  const finished = list
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .flatMap((e) => e.message.content ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
  return finished;
}

/** True when this run streamed incrementally rather than delivering one block. */
const sawStreaming = (record) =>
  events(record).some((e) => e.assistantMessageEvent?.type === "text_delta");

/** Waits until `predicate` sees the event stream it needs, or times out. */
async function waitForEvents(record, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(events(record), record)) return Date.now();
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** Pins the model, so a turn is served by a known provider rather than pi's default. */
async function selectModel(child, record) {
  child.stdin.write(
    `${JSON.stringify({ type: "set_model", id: "sel", provider: MODEL_PROVIDER, modelId: MODEL_ID })}\n`,
  );
  await waitForEvents(
    record,
    (list) => list.some((e) => e.type === "response" && e.command === "set_model"),
    30_000,
    "set_model response",
  );
  const response = events(record).find((e) => e.type === "response" && e.command === "set_model");
  if (!response.success) throw new Error(`set_model failed: ${response.error}`);
}

const scenarios = {
  /** #1 + #4 + #6: preflight over a plain alias. */
  async preflight() {
    const started = Date.now();
    const result = spawnSync(
      "ssh",
      [...SSH_OPTIONS, HOST, `${shellQuote(LAUNCHER)} '--preflight' '${payload()}'`],
      { encoding: "utf8", timeout: 60_000 },
    );
    let parsed = null;
    try {
      parsed = JSON.parse((result.stdout ?? "").trim().split("\n").pop());
    } catch {
      /* left null — the raw text is reported instead */
    }
    return {
      scenario: "1/4/6 preflight",
      elapsedMs: Date.now() - started,
      exitCode: result.status,
      report: parsed,
      raw: parsed ? undefined : (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim() || undefined,
    };
  },

  /** #7: normal completion — close stdin, the way quitting the app does. */
  async normalExit() {
    const { child, record, exited, ready } = startRun();
    await ready;
    const live = remoteState();
    const closedAt = Date.now();
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;
    await sleep(2000);
    const after = remoteState();
    return {
      scenario: "7 normal completion",
      livePiPids: live.piPids,
      liveDetails: live.details,
      msToLocalExit: record.exitedAt - closedAt,
      localExitCode: record.exitCode,
      localSignal: record.signal,
      remotePiAfter: after.piPids,
      remoteLauncherAfter: after.launcherPids,
      remotePiSurvived: after.piPids.length > 0,
      stderr: record.stderr.trim() || undefined,
    };
  },

  /**
   * #9: partition. Blocks the measured connection only, by source port, so the
   * control channel this harness needs is never at risk — a blanket DROP on 22
   * would lock the host out with no recovery path.
   */
  async partition() {
    const { child, record, exited, ready } = startRun();
    await ready;
    const live = remoteState();
    if (live.launcherPids.length !== 1) {
      child.kill("SIGKILL");
      return {
        scenario: "9 partition",
        error: `expected exactly one launcher, saw ${live.launcherPids.length} — run 'reap' first`,
      };
    }
    // Derive the peer port from the sshd session that actually owns this run:
    // launcher -> its ppid is that sshd. Picking "the newest connection" instead
    // could block the harness's own control channel and strand the rule.
    const sshdPid = probe(`ps -o ppid= -p ${live.launcherPids[0]} | tr -d ' '`);
    const target = probe(
      [
        `ss -tnpH state established 2>/dev/null | grep -F "pid=${sshdPid}," |`,
        `awk '{print $4}' | awk -F: '{print $NF}' | head -1`,
      ].join(" "),
    );
    if (!/^\d+$/.test(target)) {
      child.kill("SIGKILL");
      return { scenario: "9 partition", error: `could not resolve peer port (sshd ${sshdPid})` };
    }
    const rule = `-p tcp --sport 22 --dport ${target} -j DROP`;
    // Self-removing safety net: if this harness dies mid-scenario the rule must
    // not outlive it. Scoped to one peer port, so the control channel is never
    // at risk either way.
    probe(
      [
        `iptables -I OUTPUT ${rule}`,
        `nohup sh -c 'sleep 240; iptables -D OUTPUT ${rule} 2>/dev/null' >/dev/null 2>&1 &`,
        `echo blocked`,
      ].join("\n"),
    );
    const blockedAt = Date.now();
    let detectionMs = null;
    try {
      await Promise.race([
        exited.then(() => {
          detectionMs = record.exitedAt - blockedAt;
        }),
        sleep(180_000),
      ]);
    } finally {
      probe(`iptables -D OUTPUT ${rule} 2>/dev/null; echo restored`);
    }
    const after = remoteState();
    if (record.exitCode === null) child.kill("SIGKILL");
    return {
      scenario: "9 partition",
      blockedPeerPort: target,
      livePiPids: live.piPids,
      detectionMs,
      detectedWithin180s: detectionMs !== null,
      localExitCode: record.exitCode,
      localSignal: record.signal,
      remotePiAfterDetection: after.piPids,
      remoteLauncherAfterDetection: after.launcherPids,
      remotePiSurvivedPartition: after.piPids.length > 0,
      remotePiDetails: after.details,
      stderr: record.stderr.trim() || undefined,
    };
  },

  /** #10: desktop crash — SIGKILL the local ssh, nothing gets to clean up. */
  async desktopCrash() {
    const { child, record, exited, ready } = startRun();
    await ready;
    const live = remoteState();
    child.kill("SIGKILL");
    await exited;
    const checks = [];
    for (const wait of [2000, 10_000, 30_000]) {
      await sleep(wait);
      const state = remoteState();
      checks.push({ afterMs: wait, piPids: state.piPids, details: state.details });
    }
    const final = checks[checks.length - 1];
    if (final.piPids.length > 0) {
      probe(`kill -TERM ${final.piPids.join(" ")} 2>/dev/null; echo cleaned`);
    }
    return {
      scenario: "10 desktop crash",
      livePiPids: live.piPids,
      localExitCode: record.exitCode,
      localSignal: record.signal,
      checks,
      orphanCleanupWasNeeded: final.piPids.length > 0,
    };
  },

  /**
   * #9b: bidirectional partition — the case that decides RAV2's whole premise.
   *
   * `partition` blocks only server→client, so the server's TCP eventually gives
   * up and sends RST: the channel dies from the *server* side, sshd sees it, and
   * SIGHUP reaches pi. That is the benign shape.
   *
   * Blocking both directions removes that signal. The client now detects via its
   * own `ServerAlive` probes, while the server's sshd learns nothing until its own
   * timers expire — so this measures the window in which the desktop has given up
   * while the remote pi is still running and still holding the session file. That
   * window is the reason D2 exists and the reason a detached task needs an id.
   */
  async fullPartition() {
    const { child, record, exited, ready } = startRun();
    await ready;
    const live = remoteState();
    if (live.launcherPids.length !== 1) {
      child.kill("SIGKILL");
      return {
        scenario: "9b full partition",
        error: `expected exactly one launcher, saw ${live.launcherPids.length} — run 'reap' first`,
      };
    }
    const sshdPid = probe(`ps -o ppid= -p ${live.launcherPids[0]} | tr -d ' '`);
    const target = probe(
      [
        `ss -tnpH state established 2>/dev/null | grep -F "pid=${sshdPid}," |`,
        `awk '{print $4}' | awk -F: '{print $NF}' | head -1`,
      ].join(" "),
    );
    if (!/^\d+$/.test(target)) {
      child.kill("SIGKILL");
      return { scenario: "9b full partition", error: `could not resolve peer port (sshd ${sshdPid})` };
    }
    const outRule = `-p tcp --sport 22 --dport ${target} -j DROP`;
    const inRule = `-p tcp --dport 22 --sport ${target} -j DROP`;
    probe(
      [
        `iptables -I OUTPUT ${outRule}`,
        `iptables -I INPUT ${inRule}`,
        `nohup sh -c 'sleep 300; iptables -D OUTPUT ${outRule} 2>/dev/null; iptables -D INPUT ${inRule} 2>/dev/null' >/dev/null 2>&1 &`,
        `echo blocked`,
      ].join("\n"),
    );
    const blockedAt = Date.now();
    let clientDetectionMs = null;
    void exited.then(() => {
      clientDetectionMs = record.exitedAt - blockedAt;
    });
    // Sample the remote side while the client is blind: this is the survival
    // window, and its length is what a supervisor has to be able to report on.
    const samples = [];
    for (const at of [10_000, 30_000, 60_000, 90_000, 120_000]) {
      await sleep(at - (Date.now() - blockedAt));
      const state = remoteState();
      samples.push({
        atMs: Date.now() - blockedAt,
        clientExited: record.exitCode !== null || record.signal !== null,
        clientDetectionMs,
        remotePi: state.piPids,
        remoteLauncher: state.launcherPids,
        details: state.details,
      });
      if (state.piPids.length === 0) break;
    }
    probe(
      [
        `iptables -D OUTPUT ${outRule} 2>/dev/null`,
        `iptables -D INPUT ${inRule} 2>/dev/null`,
        `echo restored`,
      ].join("\n"),
    );
    await sleep(5000);
    const afterRestore = remoteState();
    if (record.exitCode === null && record.signal === null) child.kill("SIGKILL");
    const survivedPast = samples.filter((s) => s.remotePi.length > 0).pop();
    return {
      scenario: "9b full partition",
      blockedPeerPort: target,
      livePiPids: live.piPids,
      clientDetectionMs,
      localExitCode: record.exitCode,
      localSignal: record.signal,
      samples,
      remotePiStillAliveAtMs: survivedPast?.atMs ?? 0,
      remotePiAfterRestore: afterRestore.piPids,
      stderr: record.stderr.trim() || undefined,
    };
  },

  /** Sanity check that a real model turn completes over the SSH channel. */
  async modelTurn() {
    const { child, record, exited, ready } = startRun();
    await ready;
    await selectModel(child, record);
    const askedAt = Date.now();
    child.stdin.write(
      `${JSON.stringify({ type: "prompt", id: "t", message: "Reply with exactly: SOL_OK" })}\n`,
    );
    await waitForEvents(record, (l) => l.some((e) => e.type === "agent_settled"), 120_000, "agent_settled");
    const settledAt = Date.now();
    const streamed = sawStreaming(record);
    child.kill("SIGTERM");
    await exited;
    return {
      scenario: "model turn",
      model: `${MODEL_PROVIDER}/${MODEL_ID}`,
      msToSettled: settledAt - askedAt,
      streamedIncrementally: streamed,
      assistantText: assistantText(record).trim(),
      jsonlLines: events(record).length,
    };
  },

  /**
   * #8: cancel a running turn. Measures what `stopConfirmedAt` would have to
   * mean: how long after the stop request the remote process is actually gone,
   * and whether pi acknowledges the interrupt in-band before dying.
   */
  async cancelMidTurn() {
    const { child, record, exited, ready } = startRun();
    await ready;
    await selectModel(child, record);
    child.stdin.write(
      `${JSON.stringify({
        type: "prompt",
        id: "long",
        message: "Count slowly from 1 to 400, one number per line, no commentary.",
      })}\n`,
    );
    // Interrupt only once the model is demonstrably producing output, so this
    // measures cancelling real work rather than cancelling a pending request.
    await waitForEvents(
      record,
      (l) => l.some((e) => e.assistantMessageEvent?.type === "text_delta"),
      120_000,
      "first text delta",
    );
    const live = remoteState();
    const streamedBefore = assistantText(record).length;
    const requestedAt = Date.now();
    child.stdin.write(`${JSON.stringify({ type: "abort", id: "stop" })}\n`);
    let abortedAt = null;
    try {
      await waitForEvents(
        record,
        (l) =>
          l.some(
            (e) =>
              e.assistantMessageEvent?.type === "error" &&
              e.assistantMessageEvent?.reason === "aborted",
          ) || l.some((e) => e.type === "agent_settled"),
        30_000,
        "abort acknowledgement",
      );
      abortedAt = Date.now();
    } catch {
      /* recorded as null — an unacknowledged interrupt is itself the finding */
    }
    // Now end the channel and time how long the remote side takes to disappear.
    const closedAt = Date.now();
    child.kill("SIGTERM");
    await exited;
    let goneAtMs = null;
    for (const at of [1000, 3000, 6000, 12_000]) {
      await sleep(at - (Date.now() - closedAt));
      if (remoteState().piPids.length === 0) {
        goneAtMs = Date.now() - closedAt;
        break;
      }
    }
    return {
      scenario: "8 cancel while running",
      livePiPids: live.piPids,
      streamedCharsBeforeInterrupt: streamedBefore,
      msToAbortAck: abortedAt === null ? null : abortedAt - requestedAt,
      abortAcknowledgedInBand: abortedAt !== null,
      msToRemoteGoneAfterClose: goneAtMs,
      remoteStillAlive: goneAtMs === null,
    };
  },

  /**
   * #13: sustained output. The launcher's stdout is Pi's JSONL, and RAV2 wants to
   * journal that stream, so the numbers here set the journal's byte caps.
   */
  async longOutput() {
    const { child, record, exited, ready } = startRun();
    await ready;
    await selectModel(child, record);
    const askedAt = Date.now();
    child.stdin.write(
      `${JSON.stringify({
        type: "prompt",
        id: "big",
        message:
          "Output the numbers 1 through 1200, one per line, with no commentary before or after.",
      })}\n`,
    );
    await waitForEvents(record, (l) => l.some((e) => e.type === "agent_settled"), 240_000, "agent_settled");
    const elapsed = Date.now() - askedAt;
    const list = events(record);
    const deltas = list.filter((e) => e.assistantMessageEvent?.type === "text_delta");
    const text = assistantText(record);
    const longestLine = Math.max(...record.stdout.split("\n").map((l) => l.length));
    child.kill("SIGTERM");
    await exited;
    return {
      scenario: "13 long output",
      msToSettled: elapsed,
      jsonlLines: list.length,
      textDeltaEvents: deltas.length,
      assistantChars: text.length,
      stdoutBytes: Buffer.byteLength(record.stdout),
      longestJsonlLineChars: longestLine,
      bytesPerSecond: Math.round(Buffer.byteLength(record.stdout) / (elapsed / 1000)),
      stderrBytes: Buffer.byteLength(record.stderr),
    };
  },

  /**
   * V2.1-V2.4 against the real `pi`, which every launcher unit test fakes.
   *
   * A fake pi does not rewrite its argv, does not produce 138x-amplified JSONL, and
   * disappears the moment it is signalled — so the three things this measures are
   * exactly the three a fake cannot show: that the recorded pid survives argv
   * rewriting, that the task outlives its starting channel, and that stop has two
   * timestamps seconds apart.
   *
   * Ships the current launcher to a scratch path rather than using the installed one,
   * which has drifted. Runs under the real `$HOME`, because the launcher's node
   * discovery is `$HOME`-relative on this class of host — overriding it would test a
   * configuration the desktop never produces. Isolation is the unique task id, and
   * the finally block removes that task directory as well as stopping the task.
   */
  async detached() {
    const dir = "/tmp/pi-detached-acceptance";
    const launcher = `${dir}/launcher`;
    const taskId = `acc-${Date.now().toString(36)}`;
    const source = readFileSync("remote-launcher/pi-desktop-launcher", "utf8").replaceAll("\r\n", "\n");
    const run = (script) => probe(`sh ${shellQuote(launcher)} ${script}`);
    const task = (mode, argument) =>
      JSON.parse(run(`${shellQuote(mode)} ${argument ? shellQuote(argument) : ""}`).split("\n").filter(Boolean).pop());

    const install = spawnSync("ssh", [...SSH_OPTIONS, HOST, `rm -rf ${dir} && mkdir -p ${dir} && cat > ${launcher} && chmod 700 ${launcher}`], {
      input: source,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (install.status !== 0) throw new Error(`could not install the launcher: ${(install.stderr ?? "").trim()}`);

    const result = { scenario: "detached real pi", remoteTaskId: taskId };
    try {
      const startedAt = Date.now();
      const started = task("--start-detached", payload({ remoteTaskId: taskId }));
      if (started.ok !== true) throw new Error(`start failed: ${JSON.stringify(started)}`);
      result.msToStart = Date.now() - startedAt;
      result.pid = started.pid;
      result.supervisorPid = started.supervisorPid;
      result.stdinReady = started.stdinReady;

      // The launcher's own view, and the host's. If pi rewrote its argv to a bare `pi`
      // — it does — then only the recorded pid finds it, which is the whole reason
      // pi.pid exists.
      result.argvAfterRewrite = probe(`strings /proc/${started.pid}/cmdline 2>/dev/null | tr "\n" " " || echo "(unreadable)"`).trim() || "(empty)";
      result.argvBytes = probe(`wc -c < /proc/${started.pid}/cmdline 2>/dev/null || echo -1`).trim();
      result.argvRendered = probe(`tr -c "[:print:]" "." < /proc/${started.pid}/cmdline 2>/dev/null || echo "(unreadable)"`).trim();
      const pgrepF = probe(`pgrep -f "pi --mode rpc" 2>/dev/null | tr "\n" "," || true`).trim();
      // Excludes the probe's own shell, whose cmdline necessarily contains the pattern.
      result.recordedPidFoundByPgrepF = pgrepF.split(",").filter(Boolean).includes(String(started.pid));
      result.recordedPidFoundByPgrepX = probe(`pgrep -x pi 2>/dev/null | tr "\n" "," || true`)
        .trim().split(",").filter(Boolean).includes(String(started.pid));

      // The point of detached: the channel that started it has already closed, and each
      // probe below is a *new* ssh session.
      const afterStart = task("--status", taskId);
      result.stateAfterStartingChannelClosed = afterStart.task.state;
      result.staleAfterStartingChannelClosed = afterStart.task.stale;

      // A real model turn, driven through the FIFO by --send with an idempotency key.
      await selectModelDetached(run, taskId);
      const askedAt = Date.now();
      const key = `acc-${taskId}`;
      const sent = probe(
        `printf %s ${shellQuote(JSON.stringify({ idempotencyKey: key, payload: `${JSON.stringify({ type: "prompt", id: "t", message: "Reply with exactly: SOL_OK" })}
` }))}` +
          ` | sh ${shellQuote(launcher)} '--send' ${shellQuote(taskId)}`,
      );
      result.send = JSON.parse(sent.split("\n").filter(Boolean).pop());

      const settled = await waitForJournal(run, taskId, (records) =>
        records.some((r) => r.stream === "stdout" && /"type"s*:s*"agent_settled"/.test(r.data ?? "")), 180_000);
      result.msToSettled = Date.now() - askedAt;
      result.journalLines = settled.length;
      result.journalBytes = settled.reduce((sum, r) => sum + Buffer.byteLength(JSON.stringify(r)), 0);
      result.longestJournalLine = Math.max(...settled.map((r) => Buffer.byteLength(JSON.stringify(r))));
      result.stderrRecords = settled.filter((r) => r.stream === "stderr").length;
      result.assistantText = settled
        .filter((r) => r.stream === "stdout")
        .flatMap((r) => { try { return [JSON.parse(r.data)]; } catch { return []; } })
        .filter((e) => e.type === "message_end")
        .flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text))
        .join("")
        .trim()
        .slice(0, 120);

      // A retry of the same key must not produce a second turn.
      const replay = probe(
        `printf %s ${shellQuote(JSON.stringify({ idempotencyKey: key, payload: `${JSON.stringify({ type: "prompt", id: "t", message: "Reply with exactly: SOL_OK" })}
` }))}` +
          ` | sh ${shellQuote(launcher)} '--send' ${shellQuote(taskId)}`,
      );
      result.sendReplayDuplicate = JSON.parse(replay.split("\n").filter(Boolean).pop()).duplicate;

      // Attach from a cursor: what a reconnect would replay.
      const attach = run(`'--attach' ${shellQuote(Buffer.from(JSON.stringify({ protocolVersion: 1, remoteTaskId: taskId, after: 2, follow: false })).toString("base64"))}`);
      const frames = attach.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      result.attachHandshake = frames[0]?.type;
      result.attachSnapshotRequired = frames[0]?.snapshotRequired;
      result.attachFirstSequence = frames.find((f) => f.type === "event")?.sequence;
      result.attachDetachReason = frames.at(-1)?.reason;

      // What detached mode exists for. In attached mode, killing the local ssh child
      // kills the remote pi within ~2s — the OS sends FIN/RST, sshd tears down the
      // channel, and `--run` forwards SIGHUP. A detached task must survive the same
      // event, which is also what a crashed desktop looks like from the host.
      const live = spawn("ssh", [
        ...SSH_OPTIONS,
        HOST,
        `sh ${shellQuote(launcher)} '--attach' ${shellQuote(
          Buffer.from(
            JSON.stringify({ protocolVersion: 1, remoteTaskId: taskId, follow: true }),
          ).toString("base64"),
        )}`,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let attachedFrames = 0;
      live.stdout.on("data", (chunk) => {
        attachedFrames += chunk.toString().split("\n").filter(Boolean).length;
      });
      await sleep(3000);
      result.framesBeforeAttachKilled = attachedFrames;
      live.kill("SIGKILL");
      await sleep(4000);
      const afterAttachKilled = task("--status", taskId);
      result.stateAfterAttachKilled = afterAttachKilled.task.state;
      result.staleAfterAttachKilled = afterAttachKilled.task.stale;
      result.piAliveAfterAttachKilled = remoteState().piPids.includes(String(started.pid));

      // Stop: the two timestamps that were measured 17x apart on a real pi.
      const stoppedAt = Date.now();
      const stopped = task("--stop", taskId);
      result.msToStopReturn = Date.now() - stoppedAt;
      result.exitCode = stopped.task.exitCode;
      result.stopRequestedAt = stopped.task.stopRequestedAt;
      result.stopConfirmedAt = stopped.task.stopConfirmedAt;
      result.msBetweenStopRequestAndConfirm =
        stopped.task.stopConfirmedAt && stopped.task.stopRequestedAt
          ? stopped.task.stopConfirmedAt - stopped.task.stopRequestedAt
          : null;
      result.staleAfterStop = stopped.task.stale;
      result.piAliveAfterStop = remoteState().piPids.includes(String(started.pid));
    } finally {
      // Never leave a live pi behind, even on a thrown assertion.
      try { probe(`sh ${shellQuote(launcher)} '--stop' ${shellQuote(taskId)} >/dev/null 2>&1; echo done`); } catch { /* already gone */ }
      try { probe(`rm -rf ${dir} "$HOME/.pi-desktop/tasks/${taskId}"; echo cleaned`); } catch { /* best effort */ }
      result.remainingPi = remoteState().piPids;
    }
    return result;
  },

  /** Leftovers from earlier runs, so a scenario never inherits another's state. */
  async state() {
    return { scenario: "state", ...remoteState() };
  },

  async reap() {
    const before = remoteState();
    if (before.piPids.length > 0) probe(`kill -TERM ${before.piPids.join(" ")} 2>/dev/null; echo k`);
    await sleep(2000);
    return { scenario: "reap", killed: before.piPids, remaining: remoteState().piPids };
  },
};

const run = scenarios[scenario];
if (!run) {
  console.error(`usage: node scripts/remote-agent-acceptance.mjs <${Object.keys(scenarios).join("|")}> [--host alias]`);
  process.exit(2);
}

run()
  .then((result) => {
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else
      for (const [key, value] of Object.entries(result)) {
        console.log(`${key.padEnd(28)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
      }
  })
  .catch((error) => {
    console.error(`FAILED: ${error.message}`);
    process.exit(1);
  });
