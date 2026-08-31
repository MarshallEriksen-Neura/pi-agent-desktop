import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launcher = resolve("remote-launcher/pi-desktop-launcher");
const shell = process.env.SHELL || "sh";

function toPosixPath(value) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  return match ? `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}` : value;
}

function launcherEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (process.platform !== "win32") return env;

  // MSYS sh can read fd 3, but native Windows Node cannot inherit that
  // descriptor. A test-only shim materializes the heredoc, then executes
  // the correctly translated native Node path. The launcher itself still
  // executes through its real polyglot shell preamble.
  const bin = join(home, "test-bin");
  mkdirSync(bin, { recursive: true });
  const wrapper = join(bin, "node");
  const nativeNode = toPosixPath(process.execPath).replaceAll("'", "'\\''");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    "script=\"$HOME/.launcher-node.cjs\"",
    "cat <&3 > \"$script\"",
    `exec '${nativeNode}' \"$script\"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  env.PATH = `${bin};${process.env.PATH ?? ""}`;
  return env;
}

function runProviderSync(home, request) {
  const result = spawnSync(shell, [launcher, "--provider-sync"], {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    env: launcherEnv(home),
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split("\n").filter(Boolean).length, 1);
  return JSON.parse(result.stdout);
}

function withHome(callback) {
  const home = mkdtempSync(join(tmpdir(), "pi-provider-sync-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  try {
    return callback(home, join(home, ".pi", "agent"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("provider-sync inspect and apply preserve remote state and redact output", () => {
  withHome((home, agentDir) => {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      topLevel: "preserved",
      providers: {
        unrelated: { baseUrl: "https://unrelated", api: "openai-completions", models: [] },
        selected: {
          baseUrl: "https://old",
          api: "openai-completions",
          apiKey: "REMOTE_EMBEDDED_SECRET",
          models: [],
        },
      },
    }));
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      unrelated: { type: "api_key", key: "UNRELATED_SECRET" },
      selected: { type: "api_key", key: "REMOTE_AUTH_SECRET" },
    }));

    const inspected = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "inspect",
      providerIds: ["selected", "new-provider"],
    });
    assert.deepEqual(inspected, {
      ok: true,
      providers: [
        { providerId: "selected", configExists: true, authCredentialExists: true, embeddedApiKeyExists: true },
        { providerId: "new-provider", configExists: false, authCredentialExists: false, embeddedApiKeyExists: false },
      ],
    });

    const applied = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "apply",
      providers: [
        {
          providerId: "selected",
          definition: { baseUrl: "https://new", api: "openai-completions", models: [{ id: "new-model" }] },
          credential: { type: "api_key", key: "LOCAL_SECRET_MUST_NOT_REPLACE" },
        },
        {
          providerId: "new-provider",
          definition: { baseUrl: "https://new-provider", api: "openai-completions", models: [] },
          credential: { type: "api_key", key: "NEW_SECRET" },
        },
      ],
    });
    assert.deepEqual(applied, {
      ok: true,
      providers: [
        {
          providerId: "selected",
          configUpdated: true,
          credentialAction: "remoteCredentialPreserved",
          warnings: ["remoteCredentialPreserved", "remoteReloadRequired"],
        },
        {
          providerId: "new-provider",
          configUpdated: true,
          credentialAction: "willInstallApiKey",
          warnings: ["remoteReloadRequired"],
        },
      ],
    });
    const models = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    assert.equal(models.topLevel, "preserved");
    assert.deepEqual(models.providers.unrelated, {
      baseUrl: "https://unrelated", api: "openai-completions", models: [],
    });
    assert.equal(models.providers.selected.apiKey, "REMOTE_EMBEDDED_SECRET");
    assert.equal(auth.selected.key, "REMOTE_AUTH_SECRET");
    assert.equal(auth.unrelated.key, "UNRELATED_SECRET");
    assert.equal(auth["new-provider"].key, "NEW_SECRET");
    const serializedOutput = JSON.stringify(applied);
    assert.equal(serializedOutput.includes("SECRET"), false);
  });
});

test("provider-sync rejects extra envelope fields without writing secrets", () => {
  withHome((home) => {
    const result = spawnSync(shell, [launcher, "--provider-sync"], {
      input: JSON.stringify({ providerSyncProtocolVersion: 1, action: "inspect", providerIds: ["x"], secret: "DO_NOT_ECHO" }),
      encoding: "utf8",
      env: launcherEnv(home),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes("DO_NOT_ECHO"), false);
    assert.equal(result.stderr.includes("DO_NOT_ECHO"), false);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, errorCode: "syncPayloadInvalid" });
  });
});

test("provider-sync conservatively removes an old dead lock", () => {
  withHome((home, agentDir) => {
    mkdirSync(join(agentDir, ".provider-sync.lock"));
    writeFileSync(join(agentDir, ".provider-sync.lock", "owner.json"), JSON.stringify({
      pid: 2147483647,
      createdAt: Date.now() - 11 * 60 * 1000,
    }));
    const result = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "inspect",
      providerIds: ["x"],
    });
    assert.deepEqual(result.providers, [{
      providerId: "x", configExists: false, authCredentialExists: false, embeddedApiKeyExists: false,
    }]);
  });
});

if (process.platform !== "win32") {
  test("provider-sync writes configuration files with mode 0600", () => {
    withHome((home, agentDir) => {
      runProviderSync(home, {
        providerSyncProtocolVersion: 1,
        action: "apply",
        providers: [{
          providerId: "secure",
          definition: { baseUrl: "https://secure", api: "openai-completions", models: [] },
          credential: { type: "api_key", key: "SECRET" },
        }],
      });
      const modelsMode = execFileSync("stat", ["-c", "%a", join(agentDir, "models.json")], { encoding: "utf8" }).trim();
      const authMode = execFileSync("stat", ["-c", "%a", join(agentDir, "auth.json")], { encoding: "utf8" }).trim();
      assert.equal(modelsMode, "600");
      assert.equal(authMode, "600");
    });
  });

  test("provider-sync rejects symlinked configuration without following it", () => {
    withHome((home, agentDir) => {
      const outside = join(home, "outside-models.json");
      writeFileSync(outside, JSON.stringify({ untouched: true }));
      symlinkSync(outside, join(agentDir, "models.json"));
      const result = runProviderSync(home, {
        providerSyncProtocolVersion: 1,
        action: "inspect",
        providerIds: ["selected"],
      });
      assert.deepEqual(result, { ok: false, errorCode: "remoteConfigSymlinkRejected" });
      assert.deepEqual(JSON.parse(readFileSync(outside, "utf8")), { untouched: true });
    });
  });
}

test("provider-sync preserves a valid remote provider-scoped environment credential", () => {
  withHome((home, agentDir) => {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      selected: { type: "api_key", env: { ACCOUNT_ID: "remote-account", API_TOKEN: "REMOTE_SECRET" } },
    }));
    const inspected = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "inspect",
      providerIds: ["selected"],
    });
    assert.deepEqual(inspected, {
      ok: true,
      providers: [{
        providerId: "selected", configExists: false, authCredentialExists: true, embeddedApiKeyExists: false,
      }],
    });

    const applied = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "apply",
      providers: [{
        providerId: "selected",
        definition: { api: "openai-completions", models: [] },
        credential: { type: "api_key", key: "LOCAL_SECRET" },
      }],
    });
    assert.equal(applied.providers[0].credentialAction, "remoteCredentialPreserved");
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).selected, {
      type: "api_key", env: { ACCOUNT_ID: "remote-account", API_TOKEN: "REMOTE_SECRET" },
    });
    assert.equal(JSON.stringify(applied).includes("SECRET"), false);
  });
});

test("provider-sync rejects empty or malformed selected remote API-key credentials", () => {
  const credentials = [
    { type: "api_key" },
    { type: "api_key", key: "" },
    { type: "api_key", env: {} },
    { type: "api_key", env: { "bad name": "value" } },
    { type: "api_key", env: { ACCOUNT_ID: "" } },
  ];
  for (const credential of credentials) {
    withHome((home, agentDir) => {
      writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ selected: credential }));
      const result = runProviderSync(home, {
        providerSyncProtocolVersion: 1,
        action: "inspect",
        providerIds: ["selected"],
      });
      assert.deepEqual(result, { ok: false, errorCode: "remoteAuthInvalid" });
    });
  }
});

test("provider-sync accepts bounded generic sampling parameters and rejects reserved keys", () => {
  withHome((home) => {
    const accepted = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "apply",
      providers: [{
        providerId: "selected",
        definition: {
          api: "openai-completions",
          models: [{ id: "model", samplingParams: { vendorOption: { nested: [true, 1, "value"] } } }],
        },
        credential: null,
      }],
    });
    assert.equal(accepted.ok, true);
  });
  withHome((home) => {
    const samplingParams = Object.create(null);
    Object.defineProperty(samplingParams, "__proto__", { value: { unsafe: true }, enumerable: true });
    const result = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "apply",
      providers: [{
        providerId: "selected",
        definition: { api: "openai-completions", models: [{ id: "model", samplingParams }] },
        credential: null,
      }],
    });
    assert.deepEqual(result, { ok: false, errorCode: "syncPayloadInvalid" });
  });
});

test("provider-sync enforces sampling parameter depth, node, and string bounds", () => {
  const requestFor = (samplingParams) => ({
    providerSyncProtocolVersion: 1,
    action: "apply",
    providers: [{
      providerId: "selected",
      definition: { api: "openai-completions", models: [{ id: "model", samplingParams }] },
      credential: null,
    }],
  });

  let tooDeep = "value";
  for (let index = 0; index < 18; index += 1) tooDeep = { nested: tooDeep };
  for (const samplingParams of [
    tooDeep,
    { value: "x".repeat(64 * 1024 + 1) },
    { values: Array.from({ length: 100 }, () => Array(501).fill(null)) },
  ]) {
    withHome((home) => {
      const result = runProviderSync(home, requestFor(samplingParams));
      assert.deepEqual(result, { ok: false, errorCode: "syncPayloadInvalid" });
    });
  }
});

test("provider-sync fails closed on malformed selected remote OAuth", () => {
  withHome((home, agentDir) => {
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      selected: { type: "oauth", access: "SECRET", expires: Date.now() + 60_000 },
    }));
    const result = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "inspect",
      providerIds: ["selected"],
    });
    assert.deepEqual(result, { ok: false, errorCode: "remoteAuthInvalid" });
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  });
});

test("provider-sync rejects executable headers at every model level", () => {
  const definitions = [
    { headers: { Authorization: "!steal" }, models: [] },
    { models: [{ id: "model", headers: { Authorization: "!steal" } }] },
    { models: [], modelOverrides: { model: { headers: { Authorization: "!steal" } } } },
  ];
  for (const definition of definitions) {
    withHome((home) => {
      const result = runProviderSync(home, {
        providerSyncProtocolVersion: 1,
        action: "apply",
        providers: [{ providerId: "selected", definition, credential: null }],
      });
      assert.deepEqual(result, { ok: false, errorCode: "commandHeaderUnsupported" });
    });
  }
});

test("provider-sync recovers an interrupted two-file transaction idempotently", () => {
  withHome((home, agentDir) => {
    const token = "0123456789abcdef01234567";
    const names = {
      modelsTemp: `.provider-sync-${token}-models.tmp`,
      authTemp: `.provider-sync-${token}-auth.tmp`,
      modelsBackup: `.provider-sync-${token}-models.bak`,
      authBackup: `.provider-sync-${token}-auth.bak`,
    };
    const originalModels = { providers: { selected: { api: "openai-completions", models: [] } } };
    const originalAuth = { selected: { type: "api_key", key: "REMOTE_SECRET" } };
    writeFileSync(join(agentDir, names.modelsBackup), JSON.stringify(originalModels));
    writeFileSync(join(agentDir, names.authBackup), JSON.stringify(originalAuth));
    // Simulate an interruption after models.json was replaced but before auth.json.
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { partial: { models: [] } } }));
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify(originalAuth));
    writeFileSync(join(agentDir, names.authTemp), JSON.stringify({ selected: { type: "api_key", key: "NEW_SECRET" } }));
    writeFileSync(join(agentDir, ".provider-sync.journal.json"), JSON.stringify({
      ...names, modelsExisted: true, authExisted: true,
    }));
    const result = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "inspect",
      providerIds: ["selected"],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")), originalModels);
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")), originalAuth);
  });
});

test("provider-sync rejects malformed recovery journals without touching configuration", () => {
  withHome((home, agentDir) => {
    const original = { providers: { selected: { models: [] } } };
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(original));
    writeFileSync(join(agentDir, ".provider-sync.journal.json"), JSON.stringify({ modelsTemp: "../../escape" }));
    const result = runProviderSync(home, {
      providerSyncProtocolVersion: 1,
      action: "inspect",
      providerIds: ["selected"],
    });
    assert.deepEqual(result, { ok: false, errorCode: "remoteRecoveryRequired" });
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")), original);
  });
});

/*
 * Rust cannot ask a remote launcher what it supports — the only signal that a
 * host still runs a pre-provider-sync launcher is how it rejects the mode. So
 * `is_unsupported_launcher_mode` in src-tauri/src/remote_provider_sync.rs reads
 * this exact stderr text and exit code, and it distinguishes them from the
 * current launcher's own argument guard, which shares exit 64. Changing either
 * string turns "reinstall the remote launcher" back into a generic SSH failure,
 * so both are locked here rather than in Rust, where the test binary for this
 * crate cannot be loaded on Windows.
 */
test("launcher mode rejections stay distinguishable for the provider-sync client", () => {
  withHome((home) => {
    const unknownMode = spawnSync(shell, [launcher, "--provider-sync-v2"], {
      input: "",
      encoding: "utf8",
      env: launcherEnv(home),
    });
    assert.equal(unknownMode.status, 64);
    assert.equal(unknownMode.stderr.trim(), "invalid launcher mode");
    assert.equal(unknownMode.stdout, "");

    const badArguments = spawnSync(shell, [launcher, "--provider-sync", "unexpected"], {
      input: "",
      encoding: "utf8",
      env: launcherEnv(home),
    });
    assert.equal(badArguments.status, 64);
    assert.equal(badArguments.stderr.trim(), "provider_sync_invalid_arguments");
    assert.notEqual(badArguments.stderr.trim(), "invalid launcher mode");
  });
});
