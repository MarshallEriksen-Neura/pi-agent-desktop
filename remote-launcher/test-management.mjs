import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launcher = resolve("remote-launcher/pi-desktop-launcher");
const shell = process.env.SHELL || "sh";
const posix = process.platform !== "win32";
const scratchRoot = posix ? tmpdir() : resolve(".tmp");

function launcherEnv(home, extraPath = null) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (extraPath) env.PATH = `${extraPath}:${env.PATH ?? ""}`;
  if (posix) return env;

  // Native Windows Node cannot read the heredoc descriptor inherited through MSYS.
  const bin = join(home, "test-node-bin");
  mkdirSync(bin, { recursive: true });
  const wrapper = join(bin, "node");
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(process.execPath);
  const nativeNode = match
    ? `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`
    : process.execPath;
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'script="$HOME/.launcher-management-node.cjs"',
    'cat <&3 > "$script"',
    `exec '${nativeNode.replaceAll("'", "'\\''")}' "$script"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  env.PATH = `${bin};${extraPath ? `${extraPath};` : ""}${process.env.PATH ?? ""}`;
  return env;
}

function toLauncherPath(value) {
  return posix ? value : value.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
}

function manage(home, project, request, { path = null, envelopeExtra = null } = {}) {
  const envelope = {
    protocolVersion: 1,
    remoteCwd: toLauncherPath(project),
    request,
    ...(envelopeExtra ?? {}),
  };
  const result = spawnSync(shell, [launcher, "--manage"], {
    encoding: "utf8",
    env: launcherEnv(home, path),
    input: JSON.stringify(envelope),
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON reply, got: ${result.stdout}`);
  assert.ok(Buffer.byteLength(result.stdout) <= 2 * 1024 * 1024);
  return JSON.parse(lines[0]);
}

function withScratch(callback) {
  mkdirSync(scratchRoot, { recursive: true });
  const base = mkdtempSync(join(scratchRoot, "pi-management-"));
  const home = join(base, "home");
  const project = join(base, "project");
  const bin = join(home, ".local", "bin");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  try {
    return callback({ base, home, project, bin });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function writeExecutable(file, body) {
  writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`);
  chmodSync(file, 0o700);
}

function inspect(home, project, options) {
  const reply = manage(home, project, { operation: "inspect" }, options);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result;
}

test("capabilities advertise independently gated read and mutation support", () => {
  withScratch(({ home }) => {
    const result = spawnSync(shell, [launcher, "--capabilities"], {
      encoding: "utf8",
      env: launcherEnv(home),
    });
    assert.equal(result.status, 0, result.stderr);
    const reply = JSON.parse(result.stdout.trim());
    assert.equal(reply.launcherRevision, 5);
    for (const capability of [
      "pi-packages-read-v1",
      "pi-packages-mutate-v1",
      "pi-skills-read-v1",
      "pi-skills-mutate-v1",
    ]) assert.ok(reply.capabilities.includes(capability), capability);
  });
});

test("inspect returns bounded domain data without settings or lock credentials", () => {
  withScratch(({ home, project }) => {
    const agent = join(home, ".pi", "agent");
    mkdirSync(join(agent, "npm"), { recursive: true });
    mkdirSync(join(agent, "skills", "demo"), { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({
      defaultProvider: "must-not-cross-ssh",
      apiKey: "must-not-cross-ssh",
      packages: ["https://alice:super-secret@example.test/pkg.git"],
    }));
    writeFileSync(join(agent, "npm", "package-lock.json"), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/pkg": {
          version: "1.2.3",
          resolved: "https://alice:lock-secret@example.test/pkg.tgz",
          integrity: "must-not-cross-ssh",
        },
        "node_modules/pkg/node_modules/nested": { version: "9.9.9" },
      },
    }));
    writeFileSync(join(agent, "skills", "demo", "SKILL.md"), [
      "---", "name: demo", "description: Test skill", "---", "Body", "",
    ].join("\n"));

    const snapshot = inspect(home, project);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /must-not-cross-ssh|super-secret|lock-secret/);
    assert.deepEqual(JSON.parse(snapshot.globalSettings.content), {
      packages: ["https://***@example.test/pkg.git"],
    });
    assert.deepEqual(JSON.parse(snapshot.packageLocks.global), {
      lockfileVersion: 3,
      packages: { "node_modules/pkg": { version: "1.2.3" } },
    });
    assert.equal(snapshot.skills.length, 1);
    assert.match(snapshot.skills[0].sourceRef, /^skill-[0-9a-f]{64}$/);

    const source = manage(home, project, {
      operation: "readSkillSource",
      sourceRef: snapshot.skills[0].sourceRef,
    });
    assert.equal(source.ok, true);
    assert.match(source.result, /Body/);
  });
});

test("browseSkillSource parses clack and bullet output", { skip: !posix }, () => {
  const fixtures = [
    {
      output: [
        "Available Skills",
        "│    frontend-design",
        "│      Distinctive visual design guidance.",
      ],
      expected: [{ name: "frontend-design", description: "Distinctive visual design guidance." }],
    },
    {
      output: [
        "Available Skills",
        "- find-skills: Discover installable skills.",
        "* review-code: Review a codebase.",
      ],
      expected: [
        { name: "find-skills", description: "Discover installable skills." },
        { name: "review-code", description: "Review a codebase." },
      ],
    },
  ];

  for (const fixture of fixtures) {
    withScratch(({ home, project, bin }) => {
      const escaped = fixture.output.map((line) => `'${line.replaceAll("'", `'\\''`)}'`).join(" ");
      writeExecutable(join(bin, "skills"), `printf '%s\\n' ${escaped}`);
      const reply = manage(home, project, {
        operation: "browseSkillSource",
        source: "vercel-labs/skills",
      }, { path: bin });

      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.deepEqual(reply.result, fixture.expected);
    });
  }
});

test("management envelopes and operation objects require exact keys", () => {
  withScratch(({ home, project }) => {
    const envelopeReply = manage(home, project, { operation: "inspect" }, {
      envelopeExtra: { launcherPath: "/renderer-controlled" },
    });
    assert.equal(envelopeReply.ok, false);
    assert.equal(envelopeReply.errorCode, "invalidRequest");

    const invalid = [
      { operation: "inspect", extra: true },
      { operation: "readSkillSource" },
      {
        operation: "mutateSkill",
        mutation: {
          operation: "install",
          source: "owner/repo",
          skills: ["demo"],
          expectedState: `sha256-${"0".repeat(64)}`,
        },
      },
      {
        operation: "mutatePackage",
        mutation: {
          operation: "install",
          scope: "global",
          source: "npm:demo",
          expectedState: `sha256-${"0".repeat(64)}`,
          argv: ["anything"],
        },
      },
    ];
    for (const request of invalid) {
      const reply = manage(home, project, request);
      assert.equal(reply.ok, false, JSON.stringify(request));
      assert.ok(["unsupportedOperation", "invalidMutation"].includes(reply.errorCode), reply.errorCode);
    }
  });
});

test("a stale expected state is rejected under the remote lock", { skip: !posix }, () => {
  withScratch(({ home, project }) => {
    const reply = manage(home, project, {
      operation: "mutatePackage",
      mutation: {
        operation: "install",
        scope: "global",
        source: "npm:demo",
        expectedState: `sha256-${"0".repeat(64)}`,
      },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.errorCode, "stateConflict");
    assert.equal(readFileSync(join(home, ".pi", "agent", "settings.json"), { encoding: "utf8", flag: "a+" }), "");
  });
});

test("a live management lock fails closed as managementBusy", { skip: !posix }, () => {
  withScratch(({ home, project }) => {
    const snapshot = inspect(home, project);
    const lock = join(home, ".pi", "agent", ".pi-desktop-management.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const reply = manage(home, project, {
      operation: "mutatePackage",
      mutation: {
        operation: "updateAll",
        expectedState: snapshot.stateToken,
      },
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.errorCode, "managementBusy");
  });
});

test("a stale management lock is quarantined and reclaimed", { skip: !posix }, () => {
  withScratch(({ home, project, bin }) => {
    const snapshot = inspect(home, project, { path: bin });
    const lock = join(home, ".pi", "agent", ".pi-desktop-management.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({
      pid: 999_999_999,
      createdAt: Date.now() - 11 * 60 * 1000,
    }));
    writeExecutable(join(bin, "pi"), "exit 0");
    const reply = manage(home, project, {
      operation: "mutatePackage",
      mutation: {
        operation: "updateAll",
        expectedState: snapshot.stateToken,
      },
    }, { path: bin });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.code, 0);
    assert.throws(() => readFileSync(join(lock, "owner.json")), { code: "ENOENT" });
  });
});

test("a failed package CLI still returns a fresh sanitized snapshot", { skip: !posix }, () => {
  withScratch(({ home, project, bin }) => {
    const agent = join(home, ".pi", "agent");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["npm:before"] }));
    writeExecutable(join(bin, "pi"), [
      'printf \'%s\\n\' "$@" > "$HOME/pi-argv.txt"',
      'printf \'%s\\n\' \'{"packages":["npm:after"]}\' > "$HOME/.pi/agent/settings.json"',
      'printf \'failed https://alice:cli-secret@example.test token=also-secret\\n\' >&2',
      "exit 7",
    ].join("\n"));
    const before = inspect(home, project, { path: bin });
    const reply = manage(home, project, {
      operation: "mutatePackage",
      mutation: {
        operation: "install",
        scope: "global",
        source: "npm:demo",
        expectedState: before.stateToken,
      },
    }, { path: bin });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(readFileSync(join(home, "pi-argv.txt"), "utf8").trim().split("\n"), [
      "install", "npm:demo", "--approve",
    ]);
    assert.equal(reply.result.code, 7);
    assert.doesNotMatch(reply.result.stderr, /cli-secret|also-secret/);
    assert.deepEqual(JSON.parse(reply.result.snapshot.globalSettings.content).packages, ["npm:after"]);
    assert.notEqual(reply.result.snapshot.stateToken, before.stateToken);
  });
});

test("skill move reports halfDone and the post-command authoritative state", { skip: !posix }, () => {
  withScratch(({ home, project, bin }) => {
    const globalSkill = join(home, ".pi", "agent", "skills", "demo");
    mkdirSync(globalSkill, { recursive: true });
    writeFileSync(join(globalSkill, "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n");
    writeExecutable(join(bin, "skills"), [
      'if [ "$1" = "add" ]; then',
      '  mkdir -p "$PWD/.pi/skills/demo"',
      '  printf \'%s\\n\' \'---\' \'name: demo\' \'description: Demo copy\' \'---\' > "$PWD/.pi/skills/demo/SKILL.md"',
      "  exit 0",
      "fi",
      'printf \'remove failed password=do-not-return\\n\' >&2',
      "exit 9",
    ].join("\n"));
    const before = inspect(home, project, { path: bin });
    const reply = manage(home, project, {
      operation: "mutateSkill",
      mutation: {
        operation: "move",
        from: "global",
        to: "project",
        name: "demo",
        source: "owner/repo",
        expectedState: before.stateToken,
      },
    }, { path: bin });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.code, 9);
    assert.equal(reply.result.halfDone, true);
    assert.doesNotMatch(reply.result.stderr, /do-not-return/);
    assert.deepEqual(
      reply.result.snapshot.skills.map((skill) => skill.origin).sort(),
      ["global", "project"],
    );
  });
});

test("missing PI and Skills executables have stable error codes", { skip: !posix }, () => {
  withScratch(({ home, project, bin }) => {
    const realSh = spawnSync(shell, ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim();
    writeExecutable(join(bin, "sh"), [
      'if [ "${1:-}" = "-lc" ] && { [ "${2:-}" = "command -v pi" ] || [ "${2:-}" = "command -v skills" ] || [ "${2:-}" = "command -v npx" ]; }; then exit 1; fi',
      `exec '${realSh.replaceAll("'", "'\\''")}' "$@"`,
    ].join("\n"));
    const snapshot = inspect(home, project, { path: bin });
    const pkg = manage(home, project, {
      operation: "mutatePackage",
      mutation: { operation: "updateAll", expectedState: snapshot.stateToken },
    }, { path: bin });
    assert.equal(pkg.errorCode, "piCliUnavailable");
    const skills = manage(home, project, {
      operation: "mutateSkill",
      mutation: { operation: "updateAll", scope: "global", expectedState: snapshot.stateToken },
    }, { path: bin });
    assert.equal(skills.errorCode, "skillsCliUnavailable");
  });
});

test("management source keeps response, diagnostic, and resource guards enabled", () => {
  const source = readFileSync(launcher, "utf8");
  assert.match(source, /RESPONSE_MAX = 2 \* 1024 \* 1024/);
  assert.match(source, /SOURCE_OUTPUT_MAX = 64 \* 1024/);
  assert.match(source, /SETTINGS_MAX = 512 \* 1024/);
  assert.match(source, /SKILL_MAX = 256 \* 1024/);
  assert.match(source, /cleanDiagnostic/);
  assert.match(source, /responseTooLarge/);
});

test("CLI execution is wrapped in a process-group timeout", () => {
  const source = readFileSync(launcher, "utf8");
  assert.match(source, /command -v setsid/);
  assert.match(source, /kill -TERM -\\"\$child\\"/);
  assert.match(source, /kill -KILL -\\"\$child\\"/);
});
