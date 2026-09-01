/**
 * models.json entries that define no models of their own.
 *
 * pi's `ProviderConfigSchema` makes every provider field optional — `models`
 * included — and `applyModelsJson` accepts an entry that only carries
 * credentials, a baseUrl, headers, compat or modelOverrides. Those files are
 * valid and in the wild (writing `{ "anthropic": { "apiKey": "…" } }` to
 * override a built-in provider's key is the documented way to do it), so the
 * models page has to render them rather than reading `provider.models` as an
 * array and throwing on the way past.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { providerModels, type CustomProvider } from "../../src/lib/pi/models";
import {
  buildProviderEntries,
  groupPiModels,
} from "../../src/lib/pi/provider-entries";

/** What `usePi().models` looks like for two built-in providers. */
const PI_MODELS = [
  { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200000 },
  { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
];

function entryFor(entries: ReturnType<typeof buildProviderEntries>, providerId: string) {
  const found = entries.find((e) => e.providerId === providerId);
  assert.ok(found, `expected a card for ${providerId}`);
  return found;
}

test("a credential-only override renders instead of throwing", () => {
  // The shape that crashed the page: no `models` key at all.
  const custom: Record<string, CustomProvider> = { anthropic: { apiKey: "sk-ant-stub" } };

  const entries = buildProviderEntries(custom, groupPiModels(PI_MODELS), "");

  const anthropic = entryFor(entries, "anthropic");
  assert.equal(anthropic.builtin, false, "it is a models.json provider — settings/delete apply");
  assert.deepEqual(
    anthropic.allModels.map((m) => m.id),
    ["claude-opus-5", "claude-sonnet-5"],
    "stands in for the built-in card it suppresses, rather than claiming zero models"
  );
  assert.equal(anthropic.localIds.size, 0, "no row is editable — none is defined locally");
});

test("a provider appears once, not twice, when models.json overrides a built-in", () => {
  const custom: Record<string, CustomProvider> = { anthropic: { apiKey: "sk-ant-stub" } };
  const entries = buildProviderEntries(custom, groupPiModels(PI_MODELS), "");
  assert.deepEqual(
    entries.map((e) => e.providerId),
    ["anthropic", "openai"],
    "the override wins; openai still gets its own built-in card"
  );
});

test("own definitions win over pi's catalog, and only they are editable", () => {
  const custom: Record<string, CustomProvider> = {
    anthropic: {
      apiKey: "sk-ant-stub",
      models: [{ id: "claude-opus-5", name: "Opus (tuned)" }],
    },
  };

  const anthropic = entryFor(
    buildProviderEntries(custom, groupPiModels(PI_MODELS), ""),
    "anthropic"
  );
  assert.deepEqual(anthropic.allModels.map((m) => m.id), ["claude-opus-5"]);
  assert.equal(anthropic.allModels[0]?.name, "Opus (tuned)", "the local definition is shown");
  assert.deepEqual([...anthropic.localIds], ["claude-opus-5"], "and it is editable");
});

test("a modelOverrides-only entry is treated the same way", () => {
  const custom: Record<string, CustomProvider> = {
    openai: { modelOverrides: { "gpt-5": { contextWindow: 400000 } } },
  };
  const openai = entryFor(buildProviderEntries(custom, groupPiModels(PI_MODELS), ""), "openai");
  assert.deepEqual(openai.allModels.map((m) => m.id), ["gpt-5"]);
  assert.equal(openai.localIds.size, 0);
});

test("a hand-written non-array `models` degrades to empty rather than throwing", () => {
  // pi would reject the file outright; the UI still has to render something, and
  // an unreadable provider is better shown empty than vanished.
  const custom = { broken: { models: "gpt-4o" } } as unknown as Record<string, CustomProvider>;
  assert.deepEqual(providerModels(custom.broken), []);
  const entry = entryFor(buildProviderEntries(custom, {}, ""), "broken");
  assert.deepEqual(entry.allModels, []);
  assert.equal(entry.localIds.size, 0);
});

test("search matches a credential-only provider by its built-in model ids", () => {
  const custom: Record<string, CustomProvider> = { anthropic: { apiKey: "sk-ant-stub" } };
  const entries = buildProviderEntries(custom, groupPiModels(PI_MODELS), "sonnet");
  assert.deepEqual(entries.map((e) => e.providerId), ["anthropic"]);
  assert.deepEqual(entryFor(entries, "anthropic").matchedModels.map((m) => m.id), [
    "claude-sonnet-5",
  ]);
});

test("a provider with no models anywhere still gets a card via its id", () => {
  // A freshly added provider isn't in pi's list until it restarts.
  const custom: Record<string, CustomProvider> = {
    "my-proxy": { baseUrl: "https://api.example.com/v1", api: "openai-completions" },
  };
  const entries = buildProviderEntries(custom, groupPiModels(PI_MODELS), "");
  const proxy = entryFor(entries, "my-proxy");
  assert.deepEqual(proxy.allModels, [], "nothing to show yet");
  assert.equal(proxy.providerMatch, true, "but the empty search matches its id, so it renders");
});
