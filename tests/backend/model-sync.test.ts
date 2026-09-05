/**
 * End-to-end cover for the fetch-diff path: syncModels writes models.json and
 * pruneModelsFromScope clears the enabledModels refs that used to be left
 * stranded behind a removed model.
 *
 * Drives the real zustand stores over a stub PiConfigurationPort so the writes
 * are the JSON the app would actually persist.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  configureBrowserBackend,
  resetBackendContainerForTests,
  type BackendPorts,
} from "../../src/lib/backend/composition/container";
import type { PiConfigurationPort, SettingsScopeFileDto } from "../../src/lib/backend/ports";
import {
  providerModels,
  usePiModels,
  type CustomProvider,
  type ModelsJson,
  type ProviderConfig,
} from "../../src/lib/pi/models";
import { usePiSettings, type PiSettings } from "../../src/lib/pi/settings";
import { pruneModelsFromScope, type ModelRefLike } from "../../src/lib/pi/model-scope";

const PROVIDER = "my-proxy";

function modelsJson(ids: string[]): string {
  return JSON.stringify({
    providers: {
      [PROVIDER]: {
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        apiKey: "sk-stub",
        models: ids.map((id) => ({ id, name: id })),
      },
    },
  });
}

/** In-memory settings/models files + the fetched list the endpoint reports. */
function stubBackend(opts: { stored: string[]; upstream: string[]; global?: PiSettings; project?: PiSettings }) {
  const files = new Map<string, SettingsScopeFileDto>([
    [
      "global",
      {
        path: "~/.pi/agent/settings.json",
        exists: true,
        content: JSON.stringify(opts.global ?? {}),
      },
    ],
    [
      "project",
      {
        path: ".pi/settings.json",
        exists: Boolean(opts.project),
        content: opts.project ? JSON.stringify(opts.project) : "",
      },
    ],
    ["models", { path: "~/.pi/agent/models.json", exists: true, content: modelsJson(opts.stored) }],
  ]);

  const piConfiguration = {
    readSettings: async (scope: string) => ({ ...(files.get(scope) as SettingsScopeFileDto) }),
    writeSettings: async (scope: string, content: string) => {
      files.set(scope, { ...(files.get(scope) as SettingsScopeFileDto), exists: true, content });
    },
    fetchModels: async () => [...opts.upstream],
  } as unknown as PiConfigurationPort;

  configureBrowserBackend({ piConfiguration } as unknown as BackendPorts);

  return {
    models: () => JSON.parse(files.get("models")!.content) as ModelsJson,
    settings: (scope: "global" | "project") => {
      const raw = files.get(scope)!.content;
      return (raw.trim() ? JSON.parse(raw) : {}) as PiSettings;
    },
  };
}

function reset() {
  resetBackendContainerForTests();
  usePiModels.setState({ loaded: false, data: { providers: {} }, parseError: null, lastError: null });
  usePiSettings.setState({
    loaded: false,
    global: { path: "", exists: false, data: null, parseError: null },
    project: { path: "", exists: false, data: null, parseError: null },
    dirtyRestart: false,
    lastError: null,
  });
}

/**
 * The connection fields a writer takes. Every models.json field is optional (pi's
 * own schema), so a caller has to decide what a missing one means; the page
 * passes "" and lets the store omit the key.
 */
function cfgOf(provider: CustomProvider | undefined): ProviderConfig {
  return {
    baseUrl: provider?.baseUrl ?? "",
    api: provider?.api ?? "",
    apiKey: provider?.apiKey,
  };
}

/** A provider that must exist — reads through the store's own guard. */
function storedModelIds(data: ModelsJson, providerId: string): string[] {
  return providerModels(data.providers[providerId]).map((m) => m.id);
}

/** The page's pruneEnabled, minus React. */
async function pruneEnabled(removed: ModelRefLike[], allModels: ModelRefLike[]) {
  for (const scope of ["global", "project"] as const) {
    const current = usePiSettings.getState()[scope].data?.enabledModels;
    if (!Array.isArray(current) || current.length === 0) continue;
    const next = pruneModelsFromScope(current, removed, allModels);
    if (next.length === current.length) continue;
    await usePiSettings
      .getState()
      .setKey(scope, "enabledModels", next.length > 0 ? next : undefined);
  }
}

test("fetch diff: syncModels adds fresh ids and deletes the selected stale ones", async () => {
  reset();
  const disk = stubBackend({
    stored: ["gpt-4o", "retired-model"],
    upstream: ["gpt-4o", "gpt-5"],
  });
  await usePiModels.getState().load();

  const provider = usePiModels.getState().data.providers[PROVIDER];
  const stored = providerModels(provider);
  const upstream = new Set(["gpt-4o", "gpt-5"]);
  const fresh = ["gpt-4o", "gpt-5"].filter((id) => !stored.some((m) => m.id === id));
  const stale = stored.map((m) => m.id).filter((id) => !upstream.has(id));
  assert.deepEqual(fresh, ["gpt-5"]);
  assert.deepEqual(stale, ["retired-model"]);

  await usePiModels
    .getState()
    .syncModels(
      PROVIDER,
      cfgOf(provider),
      fresh.map((id) => ({ id, name: id })),
      stale
    );

  const ids = storedModelIds(disk.models(), PROVIDER);
  assert.deepEqual(ids, ["gpt-4o", "gpt-5"], "retired model is gone, fresh one added");
  assert.equal(disk.models().providers[PROVIDER]?.apiKey, "sk-stub", "credentials survive a sync");
  reset();
});

test("removing every model keeps the provider (and its key) alive", async () => {
  reset();
  const disk = stubBackend({ stored: ["only-model"], upstream: ["only-model"] });
  await usePiModels.getState().load();
  const provider = usePiModels.getState().data.providers[PROVIDER];

  await usePiModels.getState().syncModels(PROVIDER, cfgOf(provider), [], ["only-model"]);

  const after = disk.models().providers[PROVIDER];
  assert.ok(after, "provider is not dropped by a sync that empties it");
  assert.deepEqual(after.models, []);
  assert.equal(after.apiKey, "sk-stub");
  reset();
});

test("a stale model's enabledModels ref is pruned from global settings", async () => {
  reset();
  const disk = stubBackend({
    stored: ["gpt-4o", "retired-model"],
    upstream: ["gpt-4o"],
    global: { enabledModels: [`${PROVIDER}/gpt-4o`, `${PROVIDER}/retired-model`] },
  });
  await usePiModels.getState().load();
  await usePiSettings.getState().load();

  const provider = usePiModels.getState().data.providers[PROVIDER];
  const all = providerModels(provider).map((m) => ({ provider: PROVIDER, id: m.id }));

  await usePiModels.getState().syncModels(PROVIDER, cfgOf(provider), [], ["retired-model"]);
  await pruneEnabled([{ provider: PROVIDER, id: "retired-model" }], all);

  assert.deepEqual(disk.settings("global").enabledModels, [`${PROVIDER}/gpt-4o`]);
  reset();
});

test("pruning the last live ref drops enabledModels instead of leaving a dead list", async () => {
  reset();
  // A scope list of nothing but dead refs is the worst case: pi still treats it
  // as a filter, so every live model disappears from the picker.
  const disk = stubBackend({
    stored: ["retired-model"],
    upstream: [],
    global: { enabledModels: [`${PROVIDER}/retired-model`], theme: "dark" },
  });
  await usePiModels.getState().load();
  await usePiSettings.getState().load();

  await pruneEnabled([{ provider: PROVIDER, id: "retired-model" }], [
    { provider: PROVIDER, id: "retired-model" },
  ]);

  const after = disk.settings("global");
  assert.equal("enabledModels" in after, false, "key is deleted, not left as []");
  assert.equal(after.theme, "dark", "unrelated settings survive");
  reset();
});

test("a project-scope enabledModels list is swept too", async () => {
  reset();
  const disk = stubBackend({
    stored: ["gpt-4o", "retired-model"],
    upstream: ["gpt-4o"],
    global: { enabledModels: [`${PROVIDER}/retired-model`] },
    project: { enabledModels: [`${PROVIDER}/retired-model`, `${PROVIDER}/gpt-4o`] },
  });
  await usePiModels.getState().load();
  await usePiSettings.getState().load();

  await pruneEnabled([{ provider: PROVIDER, id: "retired-model" }], [
    { provider: PROVIDER, id: "gpt-4o" },
    { provider: PROVIDER, id: "retired-model" },
  ]);

  assert.equal("enabledModels" in disk.settings("global"), false);
  assert.deepEqual(disk.settings("project").enabledModels, [`${PROVIDER}/gpt-4o`]);
  reset();
});

test("an empty upstream list yields no stale set — nothing is offered for deletion", async () => {
  reset();
  stubBackend({ stored: ["gpt-4o", "o3"], upstream: [] });
  await usePiModels.getState().load();
  const provider = usePiModels.getState().data.providers[PROVIDER];

  const cfg = cfgOf(provider);
  const list = await usePiModels.getState().fetchModels(cfg.baseUrl, cfg.api, cfg.apiKey);
  // mirrors handleFetch: a zero-length response is a failed enumeration, not a
  // provider that dropped its whole catalogue
  const stale = list.length > 0 ? providerModels(provider).map((m) => m.id) : [];
  assert.deepEqual(stale, []);
  reset();
});

test("syncModels refuses to touch a models.json it couldn't parse", async () => {
  reset();
  const disk = stubBackend({ stored: ["gpt-4o"], upstream: ["gpt-4o"] });
  await usePiModels.getState().load();
  usePiModels.setState({ parseError: "Unexpected token }" });

  await usePiModels
    .getState()
    .syncModels(PROVIDER, { baseUrl: "", api: "", apiKey: undefined }, [], ["gpt-4o"]);

  assert.deepEqual(
    storedModelIds(disk.models(), PROVIDER),
    ["gpt-4o"],
    "unparseable file is left untouched"
  );
  reset();
});

test("a blank baseUrl is omitted, never written as \"\"", async () => {
  reset();
  // pi types baseUrl/api as String({ minLength: 1 }) and rejects the *whole*
  // models.json on a schema error, so persisting "" for a field the user left
  // blank would take every other provider's models down with it.
  const disk = stubBackend({ stored: ["gpt-4o"], upstream: [] });
  await usePiModels.getState().load();

  await usePiModels
    .getState()
    .updateProvider("creds-only", { baseUrl: "", api: "", apiKey: "sk-new" });

  const written = disk.models().providers["creds-only"];
  assert.ok(written, "the provider is created");
  assert.equal("baseUrl" in written, false, "no empty baseUrl key");
  assert.equal("api" in written, false, "no empty api key");
  assert.equal(written.apiKey, "sk-new");
  assert.equal(
    "models" in written,
    false,
    "and no empty models array — absent is how pi says 'no override'"
  );
  // The pre-existing provider is untouched.
  assert.deepEqual(storedModelIds(disk.models(), PROVIDER), ["gpt-4o"]);
  reset();
});

test("clearing baseUrl in the provider editor removes the override", async () => {
  reset();
  const disk = stubBackend({ stored: ["gpt-4o"], upstream: [] });
  await usePiModels.getState().load();

  await usePiModels.getState().updateProvider(PROVIDER, {
    baseUrl: "",
    api: "openai-completions",
    apiKey: "sk-stub",
  });

  const written = disk.models().providers[PROVIDER];
  assert.equal("baseUrl" in written!, false, "blanking the field clears it, not writes \"\"");
  assert.equal(written?.api, "openai-completions");
  assert.deepEqual(storedModelIds(disk.models(), PROVIDER), ["gpt-4o"], "models are preserved");
  reset();
});

test("addModel on a credential-only provider keeps its key and starts a models list", async () => {
  reset();
  const disk = stubBackend({ stored: ["gpt-4o"], upstream: [] });
  await usePiModels.getState().load();
  // Seed the shape that used to crash the page.
  usePiModels.setState({
    data: { providers: { anthropic: { apiKey: "sk-ant-stub" } } },
  });

  await usePiModels
    .getState()
    .addModel("anthropic", { baseUrl: "", api: "", apiKey: "" }, { id: "claude-opus-5" });

  const written = disk.models().providers.anthropic;
  assert.equal(written?.apiKey, "sk-ant-stub", "the existing credential survives");
  assert.deepEqual(storedModelIds(disk.models(), "anthropic"), ["claude-opus-5"]);
  assert.equal("baseUrl" in written!, false, "and no empty baseUrl is introduced");
  reset();
});

test("removeModel tolerates a malformed non-array models field", async () => {
  reset();
  const disk = stubBackend({ stored: [], upstream: [] });
  await usePiModels.getState().load();
  usePiModels.setState({
    data: {
      providers: {
        broken: { models: "not-an-array" } as unknown as CustomProvider,
      },
    },
  });

  await usePiModels.getState().removeModel("broken", "anything");

  assert.equal("broken" in disk.models().providers, false);
  reset();
});

test("model capability overrides preserve string/null semantics and prune empty entries", async () => {
  reset();
  const disk = stubBackend({ stored: ["gpt-4o"], upstream: [] });
  await usePiModels.getState().load();

  await usePiModels.getState().updateModelCapabilities("openai", "gpt-5", {
    reasoning: true,
    thinkingLevelMap: { high: "high", xhigh: null },
  });

  const written = disk.models().providers.openai;
  assert.deepEqual(written?.modelOverrides?.["gpt-5"], {
    reasoning: true,
    thinkingLevelMap: { high: "high", xhigh: null },
  });
  assert.equal("models" in written!, false, "a built-in override does not invent a models list");

  await usePiModels.getState().updateModelCapabilities("openai", "gpt-5", {
    reasoning: undefined,
    thinkingLevelMap: undefined,
  });

  assert.equal("openai" in disk.models().providers, false, "clearing the last override prunes its provider");
  assert.deepEqual(storedModelIds(disk.models(), PROVIDER), ["gpt-4o"]);
  reset();
});

test("capability edits for a local model stay on the model definition", async () => {
  reset();
  const disk = stubBackend({ stored: ["gpt-4o"], upstream: [] });
  await usePiModels.getState().load();

  await usePiModels.getState().updateModelCapabilities(PROVIDER, "gpt-4o", {
    reasoning: false,
    thinkingLevelMap: { minimal: null, low: "low-budget" },
  });

  const provider = disk.models().providers[PROVIDER];
  const model = providerModels(provider)[0];
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: "low-budget" });
  assert.equal(provider?.modelOverrides, undefined, "local definitions do not create duplicate overrides");
  assert.equal(provider?.apiKey, "sk-stub", "unrelated provider fields survive");
  reset();
});
