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
2. `prepare(profileId, providerIds)` reloads authoritative local state, validates the stored profile, inspects the remote destination through a fixed launcher operation, and stores a credential-free plan in Rust memory.
3. The UI displays the redacted destination, actions, and warnings and obtains explicit confirmation.
4. `apply(profileId, providerIds)` consumes the matching plan, revalidates the complete remote profile snapshot, and sends only provider IDs and validated provider definitions through SSH stdin.

A prepared plan is keyed by `profileId + canonical sorted providerIds`, expires after 120 seconds, is single-use, is never persisted, and is replaced only through a new prepare after the old plan expires or is consumed. Apply fails if the profile changed or was deleted.

### Previously approved automatic refresh

After a successful manual apply, the UI may persist only the approved `profileId + providerId` relationship as a non-secret preference, and exposes each relationship so the user can turn it off without another sync. A later successful local `models.json` write may submit those identifiers to `applyAutomatic`. Rust rebuilds a fresh plan from authoritative local and remote state; because credentials are never sent, automatic refresh does not install local credentials.
Local write notifications are coalesced briefly and remote applies are serialized. Failures do not roll back the already-successful local write; they surface a warning and a later local edit retries through a freshly built plan. Deleting a local provider removes its automatic relationship but does not delete the remote counterpart. Renaming is likewise non-destructive; destructive mirroring remains outside this contract.

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

Credential state is inspected only to determine whether the provider is syncable and whether an existing remote credential will be preserved. No local credential value is retained in a plan or included in the apply request.

| Local source | V1.1 action |
| --- | --- |
| `auth.json` API-key entry | Validate shape; never transfer the key or provider-scoped `env` |
| `models.json.providers[id].apiKey` | Remove it from the outgoing provider definition; never transfer it |
| `$NAME` / `${NAME}` expression | Validate as a reference; never transfer it |
| `!command` credential | Block provider; never execute or copy |
| OAuth, unknown, empty, or malformed credential | Preserve remote configuration only or block when malformed; never transfer tokens |
| no credential | Copy provider configuration only |

Existing remote credentials are preserved by the launcher. If no remote credential exists, the result reports `noCredential`; the remote host must be configured independently through its own `auth.json`, environment, or OAuth flow.

Custom header values use Pi's same expression syntax. A command-valued header blocks the provider. Header values are validated but are not copied into a credential or frontend DTO. Environment references remain unresolved and produce a warning.

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
## Project scope loading

Pi does not discover project-local model definitions from `<remoteCwd>/.pi/models.json`. For `scope: "project"`, the launcher writes to `<remoteCwd>/.pi/agent/models.json` and starts Pi with `PI_CODING_AGENT_DIR=<remoteCwd>/.pi/agent` whenever that models file exists. This intentionally isolates the project's models, auth, sessions, and settings from the remote global agent directory; credentials are still configured independently on the remote host and are never copied from the desktop.

The launcher operates only on fixed paths under remote `~/.pi/agent` for global scope or `<remoteCwd>/.pi/agent` for project scope, and, under a bounded lock:

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
