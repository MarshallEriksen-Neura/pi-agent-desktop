import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserBackendPorts } from "../../src/lib/backend/composition/browser";
import { mockRemoteProviderSyncPort } from "../../src/lib/backend/mock/remote-provider-sync";
import type {
  PreparedProviderSync,
  ProviderSyncCandidate,
  ProviderSyncResult,
  RemoteProviderSyncPort,
} from "../../src/lib/backend/ports/remote-provider-sync";
import {
  AUTO_PROVIDER_SYNC_STORAGE_KEY,
  getAutomaticProviderSyncProviderIds,
  runAutomaticProviderSync,
  removeAutomaticProviderSyncProviders,
  setAutomaticProviderSync,
  type AutoProviderSyncStorage,
} from "../../src/lib/pi/remote-provider-auto-sync";

const DESKTOP_ONLY = /available in the desktop app only/;

function assertRedacted(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    '"key"',
    '"apiKey"',
    '"credential"',
    '"definition"',
    '"headers"',
    '"baseUrl"',
    '"remoteCwd"',
    '"launcherPath"',
    '"sshArgs"',
    '"payload"',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `redacted DTO exposed ${forbidden}`);
  }
}

test("browser provider-sync port fails closed outside the desktop backend", async () => {
  assert.deepEqual(await mockRemoteProviderSyncPort.listCandidates(), []);
  await assert.rejects(mockRemoteProviderSyncPort.prepare("profile", ["provider"]), DESKTOP_ONLY);
  await assert.rejects(mockRemoteProviderSyncPort.apply("profile", ["provider"]), DESKTOP_ONLY);
  await assert.rejects(mockRemoteProviderSyncPort.applyAutomatic("profile", ["provider"]), DESKTOP_ONLY);
});

test("browser composition exposes the same desktop-only provider-sync boundary", async () => {
  const port = createBrowserBackendPorts().remoteProviderSync;
  assert.equal(port, mockRemoteProviderSyncPort);
  assert.deepEqual(await port.listCandidates(), []);
  await assert.rejects(port.prepare("profile", ["provider"]), DESKTOP_ONLY);
});

test("provider-sync frontend DTOs remain redacted and identifier-only", () => {
  const candidate: ProviderSyncCandidate = {
    providerId: "custom-provider",
    modelCount: 2,
    syncable: true,
    credentialSource: "providerEnvironment",
    warnings: ["providerEnvironmentNotTransferred"],
  };
  const preview: PreparedProviderSync = {
    profileId: "profile-id",
    profileRevision: 4,
    scope: "global",
    destinationDisplayName: "Remote host",
    destinationHostAlias: "work-alias",
    providers: [{
      providerId: candidate.providerId,
      modelCount: candidate.modelCount,
      configAction: "replace",
      credentialAction: "providerEnvironmentNotTransferred",
      warnings: candidate.warnings,
    }],
    expiresAt: 123_456,
  };
  const result: ProviderSyncResult = {
    profileId: preview.profileId,
    providers: [{
      providerId: candidate.providerId,
      configUpdated: true,
      credentialAction: "providerEnvironmentNotTransferred",
      warnings: ["providerEnvironmentNotTransferred", "remoteReloadRequired"],
    }],
    reloadRequired: true,
  };

  assert.deepEqual(Object.keys(candidate).sort(), [
    "credentialSource", "modelCount", "providerId", "syncable", "warnings",
  ]);
  assert.deepEqual(Object.keys(preview.providers[0]).sort(), [
    "configAction", "credentialAction", "modelCount", "providerId", "warnings",
  ]);
  assert.deepEqual(Object.keys(result.providers[0]).sort(), [
    "configUpdated", "credentialAction", "providerId", "warnings",
  ]);
  assertRedacted(candidate);
  assertRedacted(preview);
  assertRedacted(result);
});

test("automatic provider sync isolates approved changed provider/profile/scope pairs", async () => {
  const values = new Map<string, string>();
  const storage: AutoProviderSyncStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  setAutomaticProviderSync("profile-a", ["provider-a", "provider-b"], true, storage);
  setAutomaticProviderSync("profile-a", ["provider-a"], true, storage, "project");
  setAutomaticProviderSync("profile-b", ["provider-b"], true, storage);
  setAutomaticProviderSync("profile-b", ["provider-c"], true, storage, "project");
  setAutomaticProviderSync("profile-a", ["provider-b"], false, storage);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-a", storage), ["provider-a"]);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-a", storage, "project"), ["provider-a"]);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-b", storage, "project"), ["provider-c"]);

  const calls: Array<[string, string[], string]> = [];
  const port = {
    applyAutomatic: async (profileId: string, providerIds: string[], scope = "global") => {
      calls.push([profileId, providerIds, scope]);
      if (profileId === "profile-a" && scope === "global") throw new Error("remoteProfileNotFound");
      return { profileId, providers: [], reloadRequired: true as const };
    },
  } as unknown as RemoteProviderSyncPort;
  const outcomes = await runAutomaticProviderSync(
    ["provider-a", "provider-b", "provider-c", "unapproved"],
    port,
    storage,
  );

  assert.deepEqual(calls, [
    ["profile-a", ["provider-a"], "global"],
    ["profile-a", ["provider-a"], "project"],
    ["profile-b", ["provider-b"], "global"],
    ["profile-b", ["provider-c"], "project"],
  ]);
  assert.deepEqual(outcomes.map(({ profileId, scope, providerIds, ok }) => ({ profileId, scope, providerIds, ok })), [
    { profileId: "profile-a", scope: "global", providerIds: ["provider-a"], ok: false },
    { profileId: "profile-a", scope: "project", providerIds: ["provider-a"], ok: true },
    { profileId: "profile-b", scope: "global", providerIds: ["provider-b"], ok: true },
    { profileId: "profile-b", scope: "project", providerIds: ["provider-c"], ok: true },
  ]);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-a", storage), []);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-a", storage, "project"), ["provider-a"]);
  assert.equal(values.has(AUTO_PROVIDER_SYNC_STORAGE_KEY), true);

  removeAutomaticProviderSyncProviders(["provider-a"], storage);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-a", storage, "project"), []);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-b", storage, "project"), ["provider-c"]);
  removeAutomaticProviderSyncProviders(["provider-b", "provider-c"], storage);
  assert.equal(values.has(AUTO_PROVIDER_SYNC_STORAGE_KEY), false);
});

test("automatic provider sync migrates legacy profile arrays to global scope", () => {
  const values = new Map([[AUTO_PROVIDER_SYNC_STORAGE_KEY, JSON.stringify({ "profile-a": ["provider-a"] })]]);
  const storage: AutoProviderSyncStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };

  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-a", storage), ["provider-a"]);
  assert.deepEqual(getAutomaticProviderSyncProviderIds("profile-a", storage, "project"), []);
  setAutomaticProviderSync("profile-a", ["provider-b"], true, storage, "project");
  assert.deepEqual(JSON.parse(values.get(AUTO_PROVIDER_SYNC_STORAGE_KEY) ?? "{}"), {
    "profile-a": { global: ["provider-a"], project: ["provider-b"] },
  });
});
