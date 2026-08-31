# Remote Provider Sync V1.1 Contract

## Scope

Remote Provider Sync copies explicitly selected custom provider definitions from the desktop user's local Pi configuration into a stored Remote Agent SSH profile. It is a narrow setup capability, not a remote settings browser and not a generic remote file-write or command-execution API.

Authoritative inputs are loaded by Rust from:

- local `~/.pi/agent/models.json`;
- local `~/.pi/agent/auth.json`;
- the stored remote profile in `remote-profiles.json`.

React may submit only a remote profile ID and one or more provider IDs. It never submits provider JSON, credentials, paths, profile revisions, SSH options, launcher modes, commands, environment values, or overwrite flags.

## Two-phase approval

API-key synchronization requires an exact two-phase operation:

1. `candidates` returns redacted local provider summaries.
2. `prepare(profileId, providerIds)` reloads authoritative local state, validates the stored profile, inspects the remote destination through a fixed launcher operation, and stores an exact secret-bearing plan in Rust memory.
3. The UI displays the redacted destination, actions, and warnings and obtains explicit confirmation.
4. `apply(profileId, providerIds)` consumes the matching plan, revalidates the complete remote profile snapshot, and sends the prepared payload through SSH stdin.

A prepared plan is keyed by `profileId + canonical sorted providerIds`, expires after 120 seconds, is single-use, is never persisted, and is replaced only through a new prepare after the old plan expires or is consumed. Apply fails if the profile changed or was deleted.

No redacted DTO may contain API keys, auth objects, header names/values, raw provider definitions, complete endpoint URLs with userinfo/query data, local/remote file paths, SSH/launcher arguments, or credential hashes.

## Selection validation

Before file or SSH access, Rust validates:

- 1–64 provider IDs;
- no duplicates;
- deterministic canonical sorting;
- a bounded UTF-8 byte length per ID and for the selection;
- no control characters;
- no reserved object keys: `__proto__`, `prototype`, or `constructor`;
- every selected ID exists in authoritative local `models.json`.

Any blocked selected provider fails the whole prepare before SSH. Synchronization is all-or-nothing for configuration mutations.

## Credential classification

Credential precedence is:

1. an existing local `auth.json` entry;
2. `models.json.providers[id].apiKey` only when no auth entry exists.

An OAuth or unknown auth entry prevents fallback to `models.json.apiKey`.

| Local source | V1.1 action |
| --- | --- |
| `auth.json` `{ type: "api_key", key: <literal> }` | Transfer the `key` after confirmation |
| `auth.json` `{ type: "api_key", env: <ProviderEnv> }` without `key` | Validate but do not transfer provider-scoped environment values; warn that equivalent values must be configured remotely |
| `auth.json` with both `key` and `env` | Transfer only the approved `key`; validate but omit `env` and warn |
| `auth.json` `{ type: "api_key" }` with neither `key` nor `env` | Block as empty/ambiguous credential state |
| literal `models.json.apiKey` with no auth entry | Remove from outgoing provider definition and transfer as an auth credential |
| `$NAME` / `${NAME}` expression | Preserve unresolved and warn that the value must exist remotely |
| `!command` credential | Block provider; never execute or copy |
| OAuth credential | Copy provider configuration only; never transfer tokens |
| unknown credential type | Copy provider configuration only; never transfer credential or fall back |
| no credential | Copy provider configuration only |

Custom header values use Pi's same expression syntax. A command-valued header blocks the provider. Literal header values may be copied only as part of the explicitly approved selected provider and produce a redacted warning. Environment references remain unresolved and produce a warning. No header name or value enters a frontend DTO or diagnostic.

Canonical Pi `ApiKeyCredential` fields `key` and `env` are independently optional at the type level. V1.1 validates provider-scoped `env` objects (bounded environment names and non-empty string values) but deliberately does not copy them: these values may contain additional account identifiers or secrets and are not covered by the API-key confirmation. An `env`-only credential remains a syncable configuration-only provider; a `key + env` credential sends only the approved `key`. Empty credentials and malformed/empty `env` objects fail closed.

Only fields supported by Pi's provider schema are treated as provider configuration. Arbitrary local extension code and runtime-only provider registrations are outside V1.1.

## Endpoint warnings

`baseUrl` is parsed only for classification:

- loopback destinations warn that remote `localhost` refers to the remote host;
- URL userinfo or query parameters warn that the endpoint may contain credentials;
- the full sensitive URL is not returned in previews or errors.

Warnings do not resolve, probe, or rewrite endpoints.

## Existing remote credentials

V1.1 never replaces an existing remote credential:

- an existing selected provider entry in remote `auth.json` is preserved;
- an `apiKey` embedded in the existing selected remote provider definition is preserved internally when the selected provider definition is replaced;
- the result reports `remoteCredentialPreserved`.

Selected provider configuration may be replaced because selection and confirmation explicitly authorize that configuration update. Unrelated provider definitions and unrelated auth entries are preserved.

Credential replacement requires a future challenge/confirmation contract and cannot be added as a boolean to this protocol.

## Fixed transport

The launcher adds one independent capability, `provider-sync-v1`, without changing the core launcher protocol version used by immutable chat bindings.

The only operation is:

```text
pi-desktop-launcher --provider-sync
```

No payload argument is permitted. SSH argv contains only the existing fixed SSH policy, the stored host alias, the backend-owned launcher path, and the fixed mode. Provider IDs, provider JSON, Base64 payloads, profile metadata, and credentials are prohibited from argv and environment variables.

The launcher reads one bounded JSON request from stdin and requires EOF. Rust and the launcher both cap the payload at 2 MiB. Output is one bounded sanitized JSON response on stdout. Stderr contains only fixed diagnostic codes. Raw exceptions, request fragments, provider/header values, and file contents are prohibited.

Actions inside the stdin envelope are fixed to `inspect` and `apply`, both at `providerSyncProtocolVersion: 1`. The launcher rejects unknown versions/actions, duplicate or malformed IDs, unsupported credential forms, command expressions, oversized/truncated input, and trailing non-whitespace data.

## Remote merge and recovery

The launcher operates only on fixed paths under remote `~/.pi/agent` and, under a bounded lock:

1. rejects symlinked target, lock, backup, temporary, or transaction paths;
2. treats missing `models.json`/`auth.json` as empty objects;
3. rejects malformed JSON or non-object roots without mutation;
4. preserves unrelated providers and credentials;
5. preserves existing selected remote credentials;
6. prepares and validates both complete outputs;
7. writes same-directory temporary files with mode `0600` and fsyncs them;
8. records a credential-free recovery journal;
9. replaces each file atomically where the platform supports rename;
10. rolls back the first replacement if the second replacement fails;
11. recovers interrupted transactions on the next provider-sync operation;
12. fsyncs the containing directory where supported and releases the lock in `finally`.

Atomic rename applies per file; the two-file update is recoverable, not literally atomic as a pair. Backups may contain credentials and therefore also use mode `0600`, backend-generated names, bounded retention, and no logging.

A timeout or SSH disconnect can leave outcome unknown until the next fixed invocation performs recovery. Existing remote Pi processes are not automatically restarted; successful results report `reloadRequired`.

## Stable error codes

Local validation: `providerSelectionEmpty`, `providerSelectionTooLarge`, `providerIdInvalid`, `providerIdDuplicate`, `providerNotFound`, `localModelsInvalid`, `localAuthInvalid`, `commandCredentialUnsupported`, `commandHeaderUnsupported`, `providerDefinitionInvalid`, `syncPayloadTooLarge`.

Plan lifecycle: `syncBusy`, `syncPlanMissing`, `syncPlanExpired`, `syncPlanStale`, `remoteProfileNotFound`, `remoteProfileChanged`.

Launcher/remote state: `launcherSyncUnsupported`, `syncProtocolUnsupported`, `syncPayloadInvalid`, `syncPayloadTooLarge`, `configLockTimeout`, `remoteModelsInvalid`, `remoteAuthInvalid`, `remoteConfigSymlinkRejected`, `remoteWriteFailed`, `remoteRollbackFailed`, `remoteRecoveryRequired`.

Existing normalized SSH errors remain authoritative for authentication, host-key validation, alias resolution, reachability, missing launcher/Node, timeout, and bounded-output overflow.

No error may contain a secret payload, raw child command, provider JSON, endpoint, custom header, or remote JSON content.
