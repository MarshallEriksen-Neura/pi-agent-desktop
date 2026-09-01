import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launcher = resolve("remote-launcher/pi-desktop-launcher");
const shell = process.env.SHELL || "sh";
const posix = process.platform !== "win32";

/**
 * Preflight's contract, and specifically the half that changed when the workspace moved
 * off the profile: a host has to be checkable before any directory has been picked.
 *
 * Needs a real executable to run as `pi --version`, so it is POSIX-only. Run it through
 * `scripts/run-remote-supervisor-stage0.mjs` on Windows.
 */

function withHome(callback) {
  const home = mkdtempSync(join(tmpdir(), "pi-preflight-"));
  try {
    return callback(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function preflight(home, payload) {
  const encoded = Buffer.from(JSON.stringify({ protocolVersion: 1, ...payload })).toString("base64");
  const result = spawnSync(shell, [launcher, "--preflight", encoded], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one reply line, got: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function writeFakePi(home) {
  const target = join(home, "fake-pi");
  writeFileSync(target, "#!/bin/sh\nprintf '%s\\n' 'pi 9.9.9-fake'\n");
  chmodSync(target, 0o700);
  return target;
}

test("a host is checkable with no workspace chosen yet", { skip: !posix }, () => {
  withHome((home) => {
    const reply = preflight(home, { piExecutable: writeFakePi(home), resumePath: null });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.piVersion, "pi 9.9.9-fake");
    // The whole point of the split: a profile describes a machine, and a machine is
    // ready or not ready independently of which of its projects you pick.
    assert.equal(reply.errorCode, undefined);
    // And it reports where a folder browser should open, because the desktop cannot
    // expand `$HOME` locally and the launcher only accepts absolute paths.
    assert.equal(reply.home, home);
  });
});

test("a workspace is still checked when one is supplied", { skip: !posix }, () => {
  withHome((home) => {
    const piExecutable = writeFakePi(home);
    mkdirSync(join(home, "project"));
    const ok = preflight(home, { cwd: join(home, "project"), piExecutable, resumePath: null });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.home, home);

    // A supplied directory that does not exist is still a failure — the check did not
    // get weaker, it just became optional.
    const missing = preflight(home, { cwd: join(home, "absent"), piExecutable, resumePath: null });
    assert.equal(missing.ok, false);
    assert.equal(missing.errorCode, "workspace_missing");

    // A file is not a workspace.
    writeFileSync(join(home, "notes.md"), "x");
    const notADirectory = preflight(home, { cwd: join(home, "notes.md"), piExecutable, resumePath: null });
    assert.equal(notADirectory.errorCode, "workspace_missing");
  });
});

test("cwd is optional only for preflight, never for a run", { skip: !posix }, () => {
  withHome((home) => {
    // pi has to start somewhere, so a run payload without a cwd is malformed rather
    // than defaulted — silently starting the agent in `$HOME` would put it in the wrong
    // tree with no sign of it.
    const result = spawnSync(shell, [
      launcher,
      "--run",
      Buffer.from(JSON.stringify({ protocolVersion: 1, piExecutable: "pi" })).toString("base64"),
    ], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported launcher payload/);
  });
});

test("a relative cwd is refused rather than resolved", { skip: !posix }, () => {
  withHome((home) => {
    const result = spawnSync(shell, [
      launcher,
      "--preflight",
      Buffer.from(JSON.stringify({
        protocolVersion: 1,
        cwd: "relative/project",
        piExecutable: "pi",
      })).toString("base64"),
    ], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 20_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsupported launcher payload/);
  });
});
