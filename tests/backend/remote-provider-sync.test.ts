import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserBackendPorts } from "../../src/lib/backend/composition/browser";
import { mockRemoteProviderSyncPort } from "../../src/lib/backend/mock/remote-provider-sync";
import type {
  PreparedProviderSync,
  ProviderSyncCandidate,
  ProviderSyncResult,
} from "../../src/lib/backend/ports/remote-provider-sync";

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
