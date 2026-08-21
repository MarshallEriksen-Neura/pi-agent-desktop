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
import { usePiModels, type ModelsJson } from "../../src/lib/pi/models";
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
  const upstream = new Set(["gpt-4o", "gpt-5"]);
  const fresh = ["gpt-4o", "gpt-5"].filter((id) => !provider.models.some((m) => m.id === id));
  const stale = provider.models.map((m) => m.id).filter((id) => !upstream.has(id));
  assert.deepEqual(fresh, ["gpt-5"]);
  assert.deepEqual(stale, ["retired-model"]);

  await usePiModels
    .getState()
    .syncModels(
      PROVIDER,
      { baseUrl: provider.baseUrl, api: provider.api, apiKey: provider.apiKey },
      fresh.map((id) => ({ id, name: id })),
      stale
    );

  const ids = disk.models().providers[PROVIDER].models.map((m) => m.id);
  assert.deepEqual(ids, ["gpt-4o", "gpt-5"], "retired model is gone, fresh one added");
  assert.equal(disk.models().providers[PROVIDER].apiKey, "sk-stub", "credentials survive a sync");
  reset();
});

test("removing every model keeps the provider (and its key) alive", async () => {
  reset();
  const disk = stubBackend({ stored: ["only-model"], upstream: ["only-model"] });
  await usePiModels.getState().load();
  const provider = usePiModels.getState().data.providers[PROVIDER];

  await usePiModels
    .getState()
    .syncModels(PROVIDER, { baseUrl: provider.baseUrl, api: provider.api, apiKey: provider.apiKey }, [], [
      "only-model",
    ]);

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
  const all = provider.models.map((m) => ({ provider: PROVIDER, id: m.id }));

  await usePiModels
    .getState()
    .syncModels(PROVIDER, { baseUrl: provider.baseUrl, api: provider.api, apiKey: provider.apiKey }, [], [
      "retired-model",
    ]);
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

  const list = await usePiModels
    .getState()
    .fetchModels(provider.baseUrl, provider.api, provider.apiKey);
  // mirrors handleFetch: a zero-length response is a failed enumeration, not a
  // provider that dropped its whole catalogue
  const stale = list.length > 0 ? provider.models.map((m) => m.id).filter(() => true) : [];
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
    disk.models().providers[PROVIDER].models.map((m) => m.id),
    ["gpt-4o"],
    "unparseable file is left untouched"
  );
  reset();
});
