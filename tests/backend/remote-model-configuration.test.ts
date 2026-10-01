import assert from "node:assert/strict";
import test from "node:test";
import { remoteModelChanges } from "../../src/lib/backend/ports/model-configuration";

test("remoteModelChanges emits only editable provider and model fields", () => {
  const before = { providers: {
    openai: {
      baseUrl: "https://old.example/v1",
      api: "openai-completions",
      apiKey: "remote-secret",
      headers: { Authorization: "Bearer hidden" },
      models: [{ id: "old", name: "Old", contextWindow: 1024, extra: "preserve" }],
    },
  } };
  const after = { providers: {
    openai: {
      baseUrl: "https://new.example/v1",
      api: "openai-responses",
      apiKey: "local-secret-must-not-cross",
      headers: { Authorization: "Bearer changed" },
      models: [{ id: "new", name: "New", maxTokens: 2048, extra: "drop-from-patch" }],
    },
  } };

  assert.deepEqual(remoteModelChanges(before, after), [
    { kind: "provider.edit", providerId: "openai", baseUrl: "https://new.example/v1", api: "openai-responses" },
    { kind: "model.remove", providerId: "openai", modelId: "old" },
    { kind: "model.edit", providerId: "openai", modelId: "new", fields: {
      name: "New", reasoning: null, thinkingLevelMap: null, input: null, contextWindow: null, maxTokens: 2048,
    } },
  ]);
});
