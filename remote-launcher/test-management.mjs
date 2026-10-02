import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  statSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

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

function toShellPath(value) {
  if (posix) return value;
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  return match ? `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}` : value.replaceAll("\\", "/");
}

function manage(home, project, request, { path = null, envelopeExtra = null, environment = {} } = {}) {
  const envelope = {
    protocolVersion: 1,
    remoteCwd: toLauncherPath(project),
    piExecutable: "pi",
    request,
    ...(envelopeExtra ?? {}),
  };
  const result = spawnSync(shell, [launcher, "--manage"], {
    encoding: "utf8",
    env: { ...launcherEnv(home, path), ...environment },
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

test("mutation self-inspection preserves the required configured Pi executable", () => {
  withScratch(({ home, project }) => {
    const source = readFileSync(launcher, "utf8");
    const start = source.indexOf("  const inspectFresh = () => {");
    const end = source.indexOf("  const findExecutable =", start);
    assert.ok(start >= 0 && end > start);
    const envelope = {
      protocolVersion: 1, remoteCwd: toLauncherPath(project),
      piExecutable: "/configured/not-on-path/pi", request: { operation: "mutatePackage" },
    };
    const forwarded = [];
    // Use the real inspection handler; shell indirection avoids native Windows
    // trying to execute the launcher's Unix shebang directly.
    const inspectFresh = runInNewContext(`${source.slice(start, end)}\ninspectFresh;`, {
      envelope, launcherPath: launcher,
      spawnSync: (file, args, options) => {
        assert.equal(file, launcher);
        assert.deepEqual(Array.from(args), ["--manage"]);
        forwarded.push(JSON.parse(options.input));
        return spawnSync(shell, [file, ...args], { ...options, env: launcherEnv(home) });
      },
      isObject: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
      fail: (code, detail) => { throw new Error(`${code}: ${detail}`); },
    });
    // Both the pre-mutation state check and the post-mutation refresh use this helper.
    assert.match(inspectFresh().stateToken, /^sha256-[0-9a-f]{64}$/);
    assert.match(inspectFresh().stateToken, /^sha256-[0-9a-f]{64}$/);
    assert.deepEqual(forwarded, [0, 1].map(() => ({
      protocolVersion: 1, remoteCwd: envelope.remoteCwd,
      piExecutable: envelope.piExecutable, request: { operation: "inspect" },
    })));
  });
});

test("MCP configuration uses scoped CAS snapshots, private atomic writes and never executes servers", () => {
  withScratch(({ home, project }) => {
    const options = { environment: { PI_CODING_AGENT_DIR: "", PI_MCP_CONFIG_MODE: "", PI_PACKAGE_DIR: "" } };
    const read = (scope) => manage(home, project, { operation: "readMcpConfig", scope }, options);
    const global = read("global");
    const projectFile = read("project");
    assert.equal(global.ok, true, JSON.stringify(global));
    assert.equal(global.result.exists, false);
    assert.equal(projectFile.result.exists, false);
    assert.equal(existsSync(join(project, ".pi")), false, "reads must not create directories");
    assert.match(global.result.stateToken, /^[a-f0-9]{64}$/);
    assert.equal(global.result.path, join(home, ".pi", "agent", "mcp.json"));
    assert.equal(projectFile.result.path, join(project, ".pi", "mcp.json"));
    const content = JSON.stringify({ mcpServers: { remote: { command: "touch", args: [join(home, "never-execute")],
      env: { KEY: "mcp-edit-secret" }, disabled: false } }, extra: { keep: true } });
    const save = (scope, expectedState, text = content) => manage(home, project,
      { operation: "writeMcpConfig", scope, expectedState, content: text }, options);
    const written = save("global", global.result.stateToken);
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.notEqual(written.result.stateToken, global.result.stateToken);
    assert.equal(readFileSync(global.result.path, "utf8"), content);
    assert.equal(read("project").result.exists, false);
    assert.equal(save("global", global.result.stateToken).errorCode, "configurationChanged");
    writeFileSync(global.result.path, '{"external":"newer-secret"}');
    const conflict = save("global", written.result.stateToken);
    assert.equal(conflict.errorCode, "configurationChanged");
    assert.ok(!JSON.stringify(conflict).includes("secret"));
    assert.equal(readFileSync(global.result.path, "utf8"), '{"external":"newer-secret"}');
    const large = JSON.stringify({ mcpServers: {}, note: "界".repeat(30_000) });
    const projectWritten = save("project", projectFile.result.stateToken, large);
    assert.equal(projectWritten.ok, true, JSON.stringify(projectWritten));
    assert.equal(readFileSync(projectFile.result.path, "utf8"), large, "valid configs over 64 KiB can be saved");
    if (posix) assert.equal(statSync(projectFile.result.path).mode & 0o777, 0o600);
    assert.equal(existsSync(join(home, "never-execute")), false);
    assert.ok(!readdirSync(join(home, ".pi", "agent")).some((name) => /mcp-edit|mcp.lock/.test(name)));
    const discovered = manage(home, project, { operation: "discoverMcpSources" }, options);
    assert.equal(discovered.ok, true, JSON.stringify(discovered));
    assert.ok(discovered.result.some((source) => source.path === projectFile.result.path && source.content === large));
    assert.equal(manage(home, project, { operation: "readMcpConfig", scope: "global", path: "/etc/passwd" }, options).errorCode, "unsupportedOperation");
    assert.equal(read("elsewhere").errorCode, "invalidMcpRequest");
    const latest = read("global").result;
    for (const invalid of ['{"mcpServers":[]}', '{"mcpServers":{"x":null}}', '{"mcpServers":{"x":{"disabled":"false"}}}', 'null', '{broken-secret']) {
      const rejected = save("global", latest.stateToken, invalid);
      assert.equal(rejected.errorCode, "invalidMcpConfiguration");
      assert.ok(!JSON.stringify(rejected).includes("secret"));
    }
    assert.equal(save("global", latest.stateToken, JSON.stringify({ note: "a".repeat(512 * 1024) })).errorCode, "mcpConfigTooLarge");
    const lock = join(home, ".pi", "agent", ".pi-desktop-mcp.lock");
    mkdirSync(lock);
    assert.equal(save("global", latest.stateToken).errorCode, "configurationBusy");
    assert.ok(existsSync(lock), "do not remove another writer's lock");
    rmSync(lock, { recursive: true });
    writeFileSync(global.result.path, '{broken-secret');
    const broken = read("global");
    assert.equal(broken.ok, true, "raw editor can explicitly repair malformed JSON");
    assert.equal(save("global", broken.result.stateToken).ok, true);
  });
});

test("MCP configuration follows the effective agent environment and rejects ignored project writes", () => {
  withScratch(({ home, project }) => {
    const options = { environment: { PI_CODING_AGENT_DIR: "custom-agent", PI_MCP_CONFIG_MODE: "exclusive", PI_PACKAGE_DIR: "" } };
    const global = manage(home, project, { operation: "readMcpConfig", scope: "global" }, options);
    assert.equal(global.result.path, join(project, "custom-agent", "mcp.json"));
    const file = manage(home, project, { operation: "readMcpConfig", scope: "project" }, options);
    assert.equal(manage(home, project, { operation: "writeMcpConfig", scope: "project", expectedState: file.result.stateToken, content: "{}" }, options).errorCode, "mcpProjectIgnored");
    assert.equal(existsSync(join(project, ".pi")), false);
    mkdirSync(join(project, ".pi", "agent"), { recursive: true });
    writeFileSync(join(project, ".pi", "agent", "models.json"), "{}");
    const isolated = manage(home, project, { operation: "readMcpConfig", scope: "global" }, options);
    assert.equal(isolated.result.path, join(project, ".pi", "agent", "mcp.json"));
    assert.equal(manage(home, project, { operation: "writeMcpConfig", scope: "global", expectedState: global.result.stateToken, content: "{}" }, options).errorCode, "configurationChanged", "agent directory changes invalidate old snapshots even when both files are absent");
    assert.equal(existsSync(isolated.result.path), false);
    assert.equal(existsSync(join(home, ".pi", "agent", "mcp.json")), false);
  });
});

test("MCP configuration rejects symlink directories, non-files and oversized reads without exposing secrets", () => {
  withScratch(({ base, home, project }) => {
    const options = { environment: { PI_CODING_AGENT_DIR: "", PI_MCP_CONFIG_MODE: "", PI_PACKAGE_DIR: "" } };
    const read = () => manage(home, project, { operation: "readMcpConfig", scope: "project" }, options);
    const empty = read().result;
    const outside = join(base, "outside");
    mkdirSync(outside);
    const protectedContent = '{"private":"outside-secret"}';
    writeFileSync(join(outside, "mcp.json"), protectedContent);
    symlinkSync(outside, join(project, ".pi"), posix ? "dir" : "junction");
    const failed = read();
    assert.equal(failed.errorCode, "mcpConfigUnreadable");
    assert.ok(!JSON.stringify(failed).includes("outside-secret"));
    assert.equal(manage(home, project, { operation: "writeMcpConfig", scope: "project", expectedState: empty.stateToken, content: "{}" }, options).errorCode, "symlinkRejected");
    assert.equal(readFileSync(join(outside, "mcp.json"), "utf8"), protectedContent);
    rmSync(join(project, ".pi"), { recursive: true });
    mkdirSync(join(project, ".pi", "mcp.json"), { recursive: true });
    assert.equal(read().errorCode, "mcpConfigUnreadable");
    rmSync(join(project, ".pi", "mcp.json"), { recursive: true });
    writeFileSync(join(project, ".pi", "mcp.json"), "x".repeat(512 * 1024 + 1));
    assert.equal(read().errorCode, "mcpConfigUnreadable");
    writeFileSync(join(project, ".pi", "mcp.json"), Buffer.from([0xff]));
    assert.equal(read().errorCode, "mcpConfigUnreadable", "invalid UTF-8 must not be silently replaced before editing");
    if (posix) {
      rmSync(join(project, ".pi", "mcp.json"));
      assert.equal(spawnSync("mkfifo", [join(project, ".pi", "mcp.json")]).status, 0);
      assert.equal(read().errorCode, "mcpConfigUnreadable");
    }
  });
});

test("MCP inspection is read-only, bounded, scoped and credential-free", () => {
  withScratch(({ home, project }) => {
    const agent = join(home, ".pi", "agent");
    const packageRoot = join(agent, "npm", "node_modules", "pi-mcp-adapter");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    const settings = JSON.stringify({ packages: [{ source: "npm:pi-mcp-adapter@1.2.3", extensions: [] }], apiKey: "settings-secret" });
    const config = JSON.stringify({ mcpServers: {
      enabled: { command: "touch", args: [join(home, "must-not-execute")], env: { API_KEY: "config-secret" } },
      disabled: { url: "https://user:url-secret@example.test", headers: { Authorization: "header-secret" }, disabled: true },
    } });
    writeFileSync(join(agent, "settings.json"), settings);
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "1.2.3" }));
    writeFileSync(join(project, ".pi", "mcp.json"), config);
    const options = { environment: { PI_CODING_AGENT_DIR: "", PI_MCP_CONFIG_MODE: "", PI_PACKAGE_DIR: "" } };
    const inspect = () => manage(home, project, { operation: "inspectMcp" }, options);
    let reply = inspect();
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.adapterRegistered, true);
    assert.equal(reply.result.adapterPackagePresent, true);
    assert.equal(reply.result.runtimeStatus, "unverified");
    assert.equal(reply.result.agentDirectory, agent);
    assert.equal(reply.result.sources.length, 6);
    const source = reply.result.sources.find((entry) => entry.path === join(project, ".pi", "mcp.json"));
    assert.deepEqual(source.servers, [{ name: "enabled", enabled: true }, { name: "disabled", enabled: false }]);
    for (const secret of ["settings-secret", "config-secret", "url-secret", "header-secret", "must-not-execute"]) {
      assert.ok(!JSON.stringify(reply).includes(secret), secret);
    }
    assert.equal(existsSync(join(home, "must-not-execute")), false);
    assert.equal(readFileSync(join(project, ".pi", "mcp.json"), "utf8"), config);
    assert.equal(readFileSync(join(agent, "settings.json"), "utf8"), settings);
    assert.equal(manage(home, project, { operation: "inspectMcp", command: "touch" }, options).errorCode, "unsupportedOperation");

    // Unsupported JSONC and oversized files are not falsely reported as empty/ready.
    writeFileSync(join(agent, "mcp.json"), '{ // parse-secret\n "mcpServers": {} }');
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(join(home, ".agents", "mcp.json"), "x".repeat(600 * 1024));
    writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { invalid: { url: "https://example.test", disabled: "true" } } }));
    reply = inspect();
    assert.equal(reply.result.sources.find((entry) => entry.path === join(agent, "mcp.json")).error, "unsupported");
    assert.equal(reply.result.sources.find((entry) => entry.path === join(home, ".agents", "mcp.json")).error, "unreadable");
    assert.equal(reply.result.sources.find((entry) => entry.path === join(project, ".mcp.json")).error, "unsupported");
    assert.ok(!JSON.stringify(reply).includes("parse-secret"));
    writeFileSync(join(agent, "settings.json"), '{ "packages": [secret-input');
    assert.equal(inspect().result.adapterRegistered, null);
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "another-package" }));
    assert.equal(inspect().result.adapterPackagePresent, false);

    // Project isolation must match the environment used for real Pi RPC launches.
    const isolated = join(project, ".pi", "agent");
    mkdirSync(isolated, { recursive: true });
    writeFileSync(join(isolated, "models.json"), "{}");
    writeFileSync(join(isolated, "settings.json"), JSON.stringify({ packages: ["npm:pi-mcp-adapter"] }));
    writeFileSync(join(isolated, "mcp.json"), JSON.stringify({ mcpServers: { isolated: { command: "never-run" } } }));
    reply = inspect();
    assert.equal(reply.result.agentDirectory, isolated);
    assert.equal(reply.result.adapterRegistered, true);
    assert.equal(reply.result.adapterPackagePresent, false);
    assert.ok(reply.result.sources.some((entry) => entry.path === join(isolated, "mcp.json") && entry.servers[0]?.name === "isolated"));
    assert.ok(!reply.result.sources.some((entry) => entry.path === join(agent, "mcp.json")));
    const exclusive = manage(home, project, { operation: "inspectMcp" }, { environment: { ...options.environment, PI_MCP_CONFIG_MODE: "exclusive" } });
    assert.deepEqual(exclusive.result.sources.map((entry) => entry.path), [join(isolated, "mcp.json")]);

    rmSync(join(isolated, "models.json"));
    const custom = manage(home, project, { operation: "inspectMcp" }, { environment: { ...options.environment, PI_CODING_AGENT_DIR: ".pi/agent" } });
    assert.equal(custom.result.agentDirectory, isolated);

    rmSync(join(project, ".pi"), { recursive: true, force: true });
    symlinkSync(agent, join(project, ".pi"), "junction");
    reply = inspect();
    assert.equal(reply.result.sources.find((entry) => entry.path === join(project, ".pi", "mcp.json")).error, "unreadable");
    if (posix) {
      rmSync(join(project, ".mcp.json"));
      assert.equal(spawnSync("mkfifo", [join(project, ".mcp.json")]).status, 0);
      assert.equal(inspect().result.sources.find((entry) => entry.path === join(project, ".mcp.json")).error, "unreadable");
    }
  });
});

test("capabilities advertise independently gated read and mutation support", () => {
  withScratch(({ home }) => {
    const result = spawnSync(shell, [launcher, "--capabilities"], {
      encoding: "utf8",
      env: launcherEnv(home),
    });
    assert.equal(result.status, 0, result.stderr);
    const reply = JSON.parse(result.stdout.trim());
    assert.equal(reply.launcherRevision, 27);
    for (const capability of [
      "pi-packages-read-v1",
      "pi-packages-mutate-v1",
      "pi-skills-read-v1",
      "pi-skills-mutate-v1",
      "pi-cli-read-v1",
      "pi-cli-update-v1",
      "pi-mcp-inspect-v1",
      "pi-mcp-config-read-v1",
      "pi-mcp-config-write-v1",
      "pi-models-read-v1",
      "pi-models-mutate-v1",
      "pi-models-credentials-v1",
    ]) assert.ok(reply.capabilities.includes(capability), capability);
  });
});

test("Pi CLI management uses the fixed executable and arguments from the envelope", () => {
  withScratch(({ home, project, bin }) => {
    const pi = join(bin, "pi");
    writeExecutable(pi, [
      'printf \'%s\\n\' "$@" > "$HOME/pi-cli-argv.txt"',
      'if [ "${1:-}" = "--version" ]; then printf \'0.99.0\\n\'; else printf \'updated\\n\'; fi',
    ].join("\n"));
    const options = { envelopeExtra: { remoteCwd: null, piExecutable: toShellPath(pi) } };
    const inspected = manage(home, project, { operation: "inspectPiCli" }, options);
    assert.deepEqual(inspected, { ok: true, operation: "inspectPiCli", result: { version: "0.99.0" } });
    assert.equal(readFileSync(join(home, "pi-cli-argv.txt"), "utf8").trim(), "--version");

    const updated = manage(home, project, { operation: "updatePiCli" }, options);
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.equal(updated.result.code, 0);
    assert.equal(readFileSync(join(home, "pi-cli-argv.txt"), "utf8").trim(), "update");

    const injected = manage(home, project, { operation: "updatePiCli", args: ["remove"] }, options);
    assert.equal(injected.ok, false);
    assert.equal(injected.errorCode, "unsupportedOperation");
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
    const workspacePi = manage(home, project, { operation: "inspectPiCli" });
    assert.equal(workspacePi.ok, false);
    assert.equal(workspacePi.errorCode, "invalidRequest");

    const hostInspect = manage(home, project, { operation: "inspect" }, {
      envelopeExtra: { remoteCwd: null },
    });
    assert.equal(hostInspect.ok, false);
    assert.equal(hostInspect.errorCode, "invalidRequest");
  });
});

test("package management uses the configured Pi executable when it is not on PATH", { skip: !posix }, () => {
  withScratch(({ home, project }) => {
    const configured = join(home, "custom-pi");
    writeExecutable(configured, [
      'printf \'%s\\n\' "$@" > "$HOME/custom-pi-argv.txt"',
      "exit 0",
    ].join("\n"));
    const options = { envelopeExtra: { piExecutable: toShellPath(configured) } };
    const before = inspect(home, project, options);
    const reply = manage(home, project, {
      operation: "mutatePackage",
      mutation: {
        operation: "install",
        scope: "global",
        source: "npm:demo",
        expectedState: before.stateToken,
      },
    }, options);
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.result.code, 0);
    assert.deepEqual(readFileSync(join(home, "custom-pi-argv.txt"), "utf8").trim().split("\n"), [
      "install", "npm:demo", "--approve",
    ]);
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
test("model fetch uses remote OAuth and provider headers", () => {
  withScratch(({ home, project }) => {
    const portFile = join(home, "model-fetch-port");
    const server = spawn(process.execPath, ["-e", [
      "const fs=require('node:fs'),http=require('node:http');",
      "http.createServer((req,res)=>{",
      "if(req.headers.authorization!=='Bearer remote-access'||req.headers['x-remote-header']!=='preserved'){res.statusCode=401;return res.end();}",
      "res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'remote-model'}]}));",
      "}).listen(0,'127.0.0.1',function(){fs.writeFileSync(process.argv[1],String(this.address().port));});",
    ].join(""), portFile], { stdio: "ignore" });
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert.ok(existsSync(portFile), "model fetch server did not start");
      const agent = join(home, ".pi", "agent");
      writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: {
        remote: { baseUrl: `http://127.0.0.1:${readFileSync(portFile, "utf8")}/v1`, api: "openai", headers: { "X-Remote-Header": "preserved" } },
      } }));
      writeFileSync(join(agent, "auth.json"), JSON.stringify({ remote: { type: "oauth", access: "remote-access", refresh: "remote-refresh", expires: 1 } }));
      const reply = manage(home, project, { operation: "fetchProviderModels", scope: "global", providerId: "remote" });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.deepEqual(reply.result, ["remote-model"]);
    } finally {
      server.kill();
    }
  });
});

test("model management keeps scopes, credentials, and enabled-model settings isolated", () => {
  withScratch(({ home, project }) => {
    const globalAgent = join(home, ".pi", "agent");
    const projectAgent = join(project, ".pi", "agent");
    mkdirSync(projectAgent, { recursive: true });
    writeFileSync(join(globalAgent, "settings.json"), JSON.stringify({
      enabledModels: ["global-provider/global-model"],
      keepGlobal: "yes",
    }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({
      enabledModels: ["project-provider/project-model"],
      keepProject: "yes",
    }));
    writeFileSync(join(globalAgent, "auth.json"), JSON.stringify({
      "global-provider": { type: "api_key", key: "remote-secret" },
    }));
    writeFileSync(join(globalAgent, "models.json"), JSON.stringify({
      providers: {
        "global-provider": {
          baseUrl: "https://global.example/v1", api: "openai", apiKey: "embedded-secret",
          headers: { Authorization: "Bearer hidden" },
          models: [{ id: "global-model", name: "Global" }],
        },
      },
    }));
    writeFileSync(join(projectAgent, "models.json"), JSON.stringify({
      providers: {
        "project-provider": {
          baseUrl: "https://project.example/v1", api: "openai",
          models: [{ id: "project-model", name: "Project" }],
        },
      },
    }));

    const globalReply = manage(home, project, { operation: "inspectModels", scope: "global" });
    assert.equal(globalReply.ok, true, JSON.stringify(globalReply));
    const global = globalReply.result;
    assert.deepEqual(Object.keys(global.data.providers), ["global-provider"]);
    assert.deepEqual(global.enabledModels, {
      global: ["global-provider/global-model"],
      project: ["project-provider/project-model"],
    });
    assert.doesNotMatch(JSON.stringify(global), /embedded-secret|remote-secret|hidden/);

    const projectSnapshot = manage(home, project, {
      operation: "inspectModels", scope: "project",
    });
    assert.equal(projectSnapshot.ok, true, JSON.stringify(projectSnapshot));
    assert.deepEqual(Object.keys(projectSnapshot.result.data.providers), ["project-provider"]);

    const changed = manage(home, project, {
      operation: "mutateModels", scope: "global", expectedState: global.stateToken,
      changes: [
        { kind: "provider.edit", providerId: "global-provider", baseUrl: "https://global.example/v2", api: "openai" },
        { kind: "model.edit", providerId: "global-provider", modelId: "global-model", fields: { name: "Renamed", maxTokens: 4096 } },
      ],
    });
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.equal(changed.result.data.providers["global-provider"].baseUrl, "https://global.example/v2");
    const savedGlobal = JSON.parse(readFileSync(join(globalAgent, "models.json"), "utf8"));
    assert.equal(savedGlobal.providers["global-provider"].apiKey, "embedded-secret");
    assert.equal(savedGlobal.providers["global-provider"].headers.Authorization, "Bearer hidden");
    assert.equal(savedGlobal.providers["global-provider"].models[0].maxTokens, 4096);

    const enabled = manage(home, project, {
      operation: "setEnabledModels", scope: "project", expectedState: projectSnapshot.result.stateToken,
      enabledModels: ["project-provider/project-model"],
    });
    assert.equal(enabled.ok, true, JSON.stringify(enabled));
    const savedProjectSettings = JSON.parse(readFileSync(join(project, ".pi", "settings.json"), "utf8"));
    assert.equal(savedProjectSettings.keepProject, "yes");
    assert.deepEqual(savedProjectSettings.enabledModels, ["project-provider/project-model"]);

    const conflict = manage(home, project, {
      operation: "setEnabledModels", scope: "global", expectedState: "0".repeat(64),
      enabledModels: [],
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.errorCode, "configurationChanged");
  });
});

test("model management updates provider API keys without leaking or dropping remote metadata", () => {
  withScratch(({ home, project }) => {
    const globalAgent = join(home, ".pi", "agent");
    writeFileSync(join(globalAgent, "auth.json"), JSON.stringify({
      "remote-provider": { type: "api_key", key: "auth-secret" },
      "other-provider": { type: "api_key", key: "other-auth-secret" },
    }));
    writeFileSync(join(globalAgent, "models.json"), JSON.stringify({
      providers: {
        "remote-provider": {
          baseUrl: "https://remote.example/v1",
          api: "openai",
          apiKey: "old-embedded-secret",
          headers: { Authorization: "Bearer header-secret" },
          providerMetadata: { keep: true, secret: "provider-metadata-secret" },
          models: [{
            id: "remote-model",
            name: "Remote Model",
            maxTokens: 8192,
            modelMetadata: { keep: true, secret: "model-metadata-secret" },
          }],
        },
        "other-provider": {
          api: "openai",
          apiKey: "other-embedded-secret",
          models: [{ id: "other-model", providerData: "other-model-secret" }],
        },
      },
      topLevel: "preserved",
    }));

    const snapshot = manage(home, project, { operation: "inspectModels", scope: "global" });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    assert.deepEqual(snapshot.result.data.providers["remote-provider"], {
      remoteManaged: true,
      baseUrl: "https://remote.example/v1",
      api: "openai",
      models: [{ id: "remote-model", name: "Remote Model", maxTokens: 8192 }],
      modelOverrides: {},
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /old-embedded-secret|auth-secret|header-secret|provider-metadata-secret|model-metadata-secret|other-embedded-secret|other-model-secret/);

    const updated = manage(home, project, {
      operation: "mutateModels",
      scope: "global",
      expectedState: snapshot.result.stateToken,
      changes: [{ kind: "provider.apiKey", providerId: "remote-provider", apiKey: "new-remote-api-key" }],
    });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.doesNotMatch(JSON.stringify(updated), /new-remote-api-key|old-embedded-secret|auth-secret|header-secret|provider-metadata-secret|model-metadata-secret|other-embedded-secret|other-model-secret/);

    const savedModels = JSON.parse(readFileSync(join(globalAgent, "models.json"), "utf8"));
    assert.equal(savedModels.topLevel, "preserved");
    assert.equal(savedModels.providers["remote-provider"].apiKey, "new-remote-api-key");
    assert.equal(savedModels.providers["remote-provider"].headers.Authorization, "Bearer header-secret");
    assert.deepEqual(savedModels.providers["remote-provider"].providerMetadata, {
      keep: true, secret: "provider-metadata-secret",
    });
    assert.deepEqual(savedModels.providers["remote-provider"].models[0].modelMetadata, {
      keep: true, secret: "model-metadata-secret",
    });
    assert.equal(savedModels.providers["other-provider"].apiKey, "other-embedded-secret");
    assert.deepEqual(JSON.parse(readFileSync(join(globalAgent, "auth.json"), "utf8")), {
      "remote-provider": { type: "api_key", key: "auth-secret" },
      "other-provider": { type: "api_key", key: "other-auth-secret" },
    });
  });
});

test("model management rejects unsafe provider API key updates without writing", () => {
  withScratch(({ home, project }) => {
    const globalAgent = join(home, ".pi", "agent");
    const originalModels = {
      providers: {
        "remote-provider": {
          api: "openai",
          apiKey: "original-secret",
          models: [{ id: "remote-model", unknown: "unknown-secret" }],
        },
      },
    };
    const originalAuth = {
      "remote-provider": { type: "api_key", key: "auth-secret" },
    };
    writeFileSync(join(globalAgent, "models.json"), JSON.stringify(originalModels));
    writeFileSync(join(globalAgent, "auth.json"), JSON.stringify(originalAuth));

    for (const invalidApiKey of [
      "",
      "   ",
      " leading",
      "trailing ",
      "!printf secret",
      "line\nbreak",
      "nul\u0000byte",
      42,
      null,
      { key: "nested-secret" },
    ]) {
      const snapshot = manage(home, project, { operation: "inspectModels", scope: "global" });
      assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
      const rejected = manage(home, project, {
        operation: "mutateModels",
        scope: "global",
        expectedState: snapshot.result.stateToken,
        changes: [{ kind: "provider.apiKey", providerId: "remote-provider", apiKey: invalidApiKey }],
      });
      assert.equal(rejected.ok, false, JSON.stringify(rejected));
      assert.equal(rejected.errorCode, "invalidModelRequest");
      assert.doesNotMatch(JSON.stringify(rejected), /original-secret|auth-secret|unknown-secret|nested-secret|printf secret/);
      assert.deepEqual(JSON.parse(readFileSync(join(globalAgent, "models.json"), "utf8")), originalModels);
      assert.deepEqual(JSON.parse(readFileSync(join(globalAgent, "auth.json"), "utf8")), originalAuth);
    }
  });
});

test("model management applies provider edits and API keys atomically with state tokens", () => {
  withScratch(({ home, project }) => {
    const globalAgent = join(home, ".pi", "agent");
    const modelsPath = join(globalAgent, "models.json");
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        "remote-provider": {
          baseUrl: "https://remote.example/v1",
          api: "openai",
          apiKey: "original-secret",
          models: [{ id: "remote-model", name: "Remote" }],
        },
      },
    }));

    const snapshot = manage(home, project, { operation: "inspectModels", scope: "global" });
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    const stale = manage(home, project, {
      operation: "mutateModels",
      scope: "global",
      expectedState: "0".repeat(64),
      changes: [
        { kind: "provider.edit", providerId: "remote-provider", baseUrl: "https://remote.example/v2", api: "openai" },
        { kind: "provider.apiKey", providerId: "remote-provider", apiKey: "stale-secret" },
      ],
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.errorCode, "configurationChanged");
    assert.doesNotMatch(JSON.stringify(stale), /original-secret|stale-secret/);
    assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers["remote-provider"].baseUrl, "https://remote.example/v1");

    const invalidCombined = manage(home, project, {
      operation: "mutateModels",
      scope: "global",
      expectedState: snapshot.result.stateToken,
      changes: [
        { kind: "provider.edit", providerId: "remote-provider", baseUrl: "https://remote.example/v2", api: "openai" },
        { kind: "provider.apiKey", providerId: "remote-provider", apiKey: "!unsafe-secret" },
      ],
    });
    assert.equal(invalidCombined.ok, false);
    assert.equal(invalidCombined.errorCode, "invalidModelRequest");
    assert.doesNotMatch(JSON.stringify(invalidCombined), /original-secret|unsafe-secret/);
    const afterInvalid = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(afterInvalid.providers["remote-provider"].baseUrl, "https://remote.example/v1");
    assert.equal(afterInvalid.providers["remote-provider"].apiKey, "original-secret");

    const fresh = manage(home, project, { operation: "inspectModels", scope: "global" });
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
    const validCombined = manage(home, project, {
      operation: "mutateModels",
      scope: "global",
      expectedState: fresh.result.stateToken,
      changes: [
        { kind: "provider.edit", providerId: "remote-provider", baseUrl: "https://remote.example/v2", api: "openai-completions" },
        { kind: "provider.apiKey", providerId: "remote-provider", apiKey: "combined-secret" },
        { kind: "model.edit", providerId: "remote-provider", modelId: "remote-model", fields: { name: "Renamed" } },
      ],
    });
    assert.equal(validCombined.ok, true, JSON.stringify(validCombined));
    assert.doesNotMatch(JSON.stringify(validCombined), /original-secret|combined-secret/);
    const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(saved.providers["remote-provider"].baseUrl, "https://remote.example/v2");
    assert.equal(saved.providers["remote-provider"].api, "openai-completions");
    assert.equal(saved.providers["remote-provider"].apiKey, "combined-secret");
    assert.equal(saved.providers["remote-provider"].models[0].name, "Renamed");
  });
});

test("model management rejects an active provider-sync lock", { skip: !posix }, () => {
  withScratch(({ home, project }) => {
    const lock = join(home, ".pi", "agent", ".provider-sync.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const reply = manage(home, project, { operation: "inspectModels", scope: "global" });
    assert.equal(reply.ok, false);
    assert.equal(reply.errorCode, "configurationBusy");
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
