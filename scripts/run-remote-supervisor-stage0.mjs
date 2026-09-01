#!/usr/bin/env node
// Runs the launcher's own suites on a real SSH host.
//
// Their file-logic halves run anywhere, but the supervisor needs FIFOs, /proc and real
// signals, and workspace symlink handling needs POSIX links — so `node --test` skips
// those on Windows. This stage ships the launcher and the suites to the host and runs
// them there, which is also the only place the shipped LF form of the launcher is
// exercised: the working tree is CRLF under core.autocrlf, and git stores LF.
//
//   node scripts/run-remote-supervisor-stage0.mjs [--host alias]

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const host = flag("host", "yuyun");
const remoteDir = flag("dir", "/tmp/pi-detached-verify");

const SSH_OPTIONS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
];

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function ssh(script, input) {
  const result = spawnSync("ssh", [...SSH_OPTIONS, host, script], {
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

/** The launcher must arrive with LF endings or `sh` chokes on the first line. */
function shipped(relative) {
  return readFileSync(path.join(root, relative), "utf8").replaceAll("\r\n", "\n");
}

const SUITES = [
  "remote-launcher/test-detached-tasks.mjs",
  "remote-launcher/test-workspace.mjs",
  "remote-launcher/test-preflight.mjs",
];

console.log(`[stage0] shipping the launcher and suites to ${host}:${remoteDir}`);
const prepare = ssh(`rm -rf ${quote(remoteDir)} && mkdir -p ${quote(`${remoteDir}/remote-launcher`)}`);
if (prepare.status !== 0) {
  console.error(prepare.stderr.trim() || "could not prepare the remote directory");
  process.exit(1);
}

for (const relative of ["remote-launcher/pi-desktop-launcher", ...SUITES]) {
  const remote = `${remoteDir}/${relative}`;
  const copy = ssh(`cat > ${quote(remote)}`, shipped(relative));
  if (copy.status !== 0) {
    console.error(`could not write ${remote}: ${copy.stderr.trim()}`);
    process.exit(1);
  }
}
ssh(`chmod 700 ${quote(`${remoteDir}/remote-launcher/pi-desktop-launcher`)}`);

// A login shell does not help here: Ubuntu's stock .bashrc returns early for a
// non-interactive shell, before any version-manager block, so nvm's node is on
// neither PATH. The absolute-path fallback is the primary path on that class of
// host — the same reason the launcher carries one. Resolve node explicitly and put
// its directory on PATH, because the suite reassigns HOME to a temp directory and
// the launcher's own $HOME-relative discovery cannot fire there.
const nodeProbe = ssh([
  "if command -v node >/dev/null 2>&1; then command -v node; else",
  'for c in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node /usr/local/bin/node /opt/homebrew/bin/node;',
  'do [ -x "$c" ] && printf "%s\\n" "$c"; done | tail -n 1; fi',
].join(" "));
const nodePath = flag("node", nodeProbe.stdout.trim().split("\n").filter(Boolean).pop());
if (!nodePath) {
  console.error(`[stage0] no node found on ${host}; pass --node <absolute path>`);
  process.exit(1);
}
console.log(`[stage0] running node --test on the host (${nodePath})`);
const nodeDir = nodePath.slice(0, nodePath.lastIndexOf("/")) || "/usr/bin";
const suite = ssh(
  `cd ${quote(remoteDir)} && PATH=${quote(nodeDir)}:$PATH ${quote(nodePath)} --test ${SUITES.map(quote).join(" ")}`,
);
process.stdout.write(suite.stdout);
if (suite.stderr.trim().length > 0) process.stderr.write(suite.stderr);

// Leave nothing behind: a later scenario must never inherit this run's state.
ssh(`rm -rf ${quote(remoteDir)}`);

if (suite.status !== 0) {
  console.error(`[stage0] suite failed with exit ${suite.status}`);
  process.exit(suite.status ?? 1);
}
console.log("[stage0] ok");
