//! Secure, identifier-only provider synchronization to a stored SSH profile.
//!
//! Secrets are loaded from Pi's authoritative local files, retained only in a
//! short-lived in-memory plan, and sent to the fixed launcher exclusively over
//! SSH stdin. Public DTOs contain only stable classifications and identifiers.

use crate::remote_profiles::{self, RemotePiProfile};
use pi_backend_core::pi_process::LaunchSpec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const PROVIDER_SYNC_PROTOCOL_VERSION: u32 = 1;
const MAX_SYNC_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROVIDER_ID_BYTES: usize = 128;
const MAX_SELECTION_BYTES: usize = 8 * 1024;
const MAX_PROVIDERS: usize = 64;
const MAX_ACTIVE_PLANS: usize = 32;
const MAX_PLAN_BYTES: usize = 8 * 1024 * 1024;
const MAX_MODELS_PER_PROVIDER: usize = 512;
const MAX_JSON_DEPTH: usize = 16;
const MAX_JSON_NODES: usize = 50_000;
const MAX_JSON_STRING_BYTES: usize = 64 * 1024;
const MAX_SYNC_OUTPUT_BYTES: usize = 64 * 1024;
const PLAN_TTL: Duration = Duration::from_secs(120);
const SSH_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Default)]
pub struct RemoteProviderSyncState {
    plans: Mutex<HashMap<String, SyncPlan>>,
}

struct SyncPlan {
    profile: RemotePiProfile,
    provider_ids: Vec<String>,
    request: Zeroizing<Vec<u8>>,
    preview: PreparedProviderSync,
    expires: Instant,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSyncCandidate {
    provider_id: String,
    model_count: usize,
    syncable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<&'static str>,
    credential_source: &'static str,
    warnings: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedProviderSyncProvider {
    provider_id: String,
    model_count: usize,
    config_action: &'static str,
    credential_action: &'static str,
    warnings: Vec<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedProviderSync {
    profile_id: String,
    profile_revision: u64,
    destination_display_name: String,
    destination_host_alias: String,
    providers: Vec<PreparedProviderSyncProvider>,
    expires_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedProviderSyncProvider {
    provider_id: String,
    config_updated: bool,
    credential_action: String,
    warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSyncResult {
    profile_id: String,
    providers: Vec<AppliedProviderSyncProvider>,
    reload_required: bool,
}

#[derive(Clone)]
struct LocalProvider {
    id: String,
    definition: Value,
    credential: Option<Value>,
    model_count: usize,
    syncable: bool,
    blocked_reason: Option<&'static str>,
    credential_source: &'static str,
    proposed_credential_action: &'static str,
    warnings: Vec<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LauncherResponse {
    ok: bool,
    error_code: Option<String>,
    providers: Option<Vec<LauncherProviderState>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LauncherProviderState {
    provider_id: String,
    config_exists: Option<bool>,
    auth_credential_exists: Option<bool>,
    embedded_api_key_exists: Option<bool>,
    config_updated: Option<bool>,
    credential_action: Option<String>,
    #[serde(default)]
    warnings: Vec<String>,
}

fn lock_plans(
    state: &RemoteProviderSyncState,
) -> Result<MutexGuard<'_, HashMap<String, SyncPlan>>, String> {
    state.plans.lock().map_err(|_| code("syncBusy"))
}

fn code(value: &str) -> String {
    value.to_owned()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn canonical_provider_ids(provider_ids: Vec<String>) -> Result<Vec<String>, String> {
    if provider_ids.is_empty() {
        return Err(code("providerSelectionEmpty"));
    }
    if provider_ids.len() > MAX_PROVIDERS {
        return Err(code("providerSelectionTooLarge"));
    }
    let mut seen = HashSet::with_capacity(provider_ids.len());
    let mut total = 0usize;
    for id in &provider_ids {
        let reserved = matches!(id.as_str(), "__proto__" | "prototype" | "constructor");
        if id.is_empty()
            || id.len() > MAX_PROVIDER_ID_BYTES
            || id.chars().any(char::is_control)
            || reserved
        {
            return Err(code("providerIdInvalid"));
        }
        total = total.saturating_add(id.len());
        if total > MAX_SELECTION_BYTES {
            return Err(code("providerSelectionTooLarge"));
        }
        if !seen.insert(id.as_str()) {
            return Err(code("providerIdDuplicate"));
        }
    }
    let mut ids = provider_ids;
    ids.sort();
    Ok(ids)
}

fn read_json_object(file_name: &str, invalid_code: &str) -> Result<Map<String, Value>, String> {
    let path = crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join(file_name);
    if !path.is_file() {
        return Ok(Map::new());
    }
    let metadata = fs::metadata(&path).map_err(|_| code(invalid_code))?;
    if metadata.len() > MAX_SYNC_BYTES as u64 {
        return Err(code("syncPayloadTooLarge"));
    }
    let bytes = fs::read(path).map_err(|_| code(invalid_code))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| code(invalid_code))?;
    value.as_object().cloned().ok_or_else(|| code(invalid_code))
}

fn is_env_reference(value: &str) -> bool {
    if let Some(name) = value.strip_prefix('$') {
        let name = name
            .strip_prefix('{')
            .and_then(|v| v.strip_suffix('}'))
            .unwrap_or(name);
        valid_env_name(name)
    } else {
        false
    }
}

fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.chars().enumerate().all(|(index, ch)| {
            ch == '_' || ch.is_ascii_alphanumeric() && (index > 0 || !ch.is_ascii_digit())
        })
}

fn valid_provider_env(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let Some(env) = value.as_object() else {
        return false;
    };
    !env.is_empty()
        && env.len() <= MAX_MODELS_PER_PROVIDER
        && env.iter().all(|(name, value)| {
            valid_env_name(name)
                && value
                    .as_str()
                    .is_some_and(|value| !value.is_empty() && value.len() <= MAX_JSON_STRING_BYTES)
        })
}

fn push_warning(warnings: &mut Vec<&'static str>, warning: &'static str) {
    if !warnings.contains(&warning) {
        warnings.push(warning);
    }
}

fn safe_json_key(value: &str) -> bool {
    value.len() <= MAX_PROVIDER_ID_BYTES
        && !value.chars().any(char::is_control)
        && !matches!(value, "__proto__" | "prototype" | "constructor")
}

fn validate_json_bounds(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes = nodes.saturating_add(1);
    if depth > MAX_JSON_DEPTH || *nodes > MAX_JSON_NODES {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
        Value::String(value) => value.len() <= MAX_JSON_STRING_BYTES,
        Value::Array(values) => {
            values.len() <= MAX_MODELS_PER_PROVIDER
                && values
                    .iter()
                    .all(|value| validate_json_bounds(value, depth + 1, nodes))
        }
        Value::Object(values) => {
            values.len() <= MAX_MODELS_PER_PROVIDER
                && values.iter().all(|(key, value)| {
                    safe_json_key(key) && validate_json_bounds(value, depth + 1, nodes)
                })
        }
    }
}

fn has_only_keys(value: &Map<String, Value>, allowed: &[&str]) -> bool {
    value.keys().all(|key| allowed.contains(&key.as_str()))
}

fn inspect_headers(
    value: Option<&Value>,
    syncable: &mut bool,
    blocked_reason: &mut Option<&'static str>,
    warnings: &mut Vec<&'static str>,
) {
    let Some(value) = value else {
        return;
    };
    let Some(headers) = value.as_object() else {
        *syncable = false;
        *blocked_reason = Some("invalidProviderDefinition");
        return;
    };
    for (name, value) in headers {
        let Some(value) = value.as_str() else {
            *syncable = false;
            *blocked_reason = Some("invalidProviderDefinition");
            return;
        };
        if !safe_json_key(name) || name.is_empty() || value.len() > MAX_JSON_STRING_BYTES {
            *syncable = false;
            *blocked_reason = Some("invalidProviderDefinition");
        } else if value.starts_with('!') {
            *syncable = false;
            *blocked_reason = Some("commandHeaderUnsupported");
        } else if is_env_reference(value) {
            push_warning(warnings, "environmentHeaderRequiresRemoteValue");
        } else {
            push_warning(warnings, "literalHeaderValuesTransferred");
        }
    }
}

fn validate_model_definitions(
    definition: &Map<String, Value>,
    syncable: &mut bool,
    blocked_reason: &mut Option<&'static str>,
    warnings: &mut Vec<&'static str>,
) -> usize {
    const PROVIDER_KEYS: &[&str] = &[
        "name",
        "baseUrl",
        "api",
        "oauth",
        "headers",
        "compat",
        "authHeader",
        "models",
        "modelOverrides",
    ];
    const MODEL_KEYS: &[&str] = &[
        "id",
        "name",
        "api",
        "baseUrl",
        "reasoning",
        "thinkingLevelMap",
        "input",
        "cost",
        "contextWindow",
        "maxTokens",
        "samplingParams",
        "headers",
        "compat",
    ];
    const OVERRIDE_KEYS: &[&str] = &[
        "name",
        "reasoning",
        "thinkingLevelMap",
        "input",
        "cost",
        "contextWindow",
        "maxTokens",
        "samplingParams",
        "headers",
        "compat",
    ];

    let mut nodes = 0;
    if !has_only_keys(definition, PROVIDER_KEYS)
        || !validate_json_bounds(&Value::Object(definition.clone()), 0, &mut nodes)
        || definition
            .get("name")
            .is_some_and(|value| !value.is_string())
        || definition
            .get("baseUrl")
            .is_some_and(|value| !value.is_string())
        || definition
            .get("api")
            .is_some_and(|value| !value.is_string())
        || definition
            .get("authHeader")
            .is_some_and(|value| !value.is_boolean())
        || definition
            .get("oauth")
            .is_some_and(|value| value.as_str() != Some("radius"))
    {
        *syncable = false;
        *blocked_reason = Some("invalidProviderDefinition");
    }
    inspect_headers(
        definition.get("headers"),
        syncable,
        blocked_reason,
        warnings,
    );

    let Some(models) = definition.get("models").and_then(Value::as_array) else {
        *syncable = false;
        *blocked_reason = Some("invalidProviderDefinition");
        return 0;
    };
    if models.len() > MAX_MODELS_PER_PROVIDER {
        *syncable = false;
        *blocked_reason = Some("invalidProviderDefinition");
    }
    let mut model_ids = HashSet::new();
    for model in models {
        let Some(model) = model.as_object() else {
            *syncable = false;
            *blocked_reason = Some("invalidProviderDefinition");
            continue;
        };
        let id_valid = model
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| valid_provider_id(id) && model_ids.insert(id));
        if !has_only_keys(model, MODEL_KEYS) || !id_valid {
            *syncable = false;
            *blocked_reason = Some("invalidProviderDefinition");
        }
        inspect_headers(model.get("headers"), syncable, blocked_reason, warnings);
    }

    if let Some(overrides) = definition.get("modelOverrides") {
        let Some(overrides) = overrides.as_object() else {
            *syncable = false;
            *blocked_reason = Some("invalidProviderDefinition");
            return models.len();
        };
        if overrides.len() > MAX_MODELS_PER_PROVIDER {
            *syncable = false;
            *blocked_reason = Some("invalidProviderDefinition");
        }
        for (id, model) in overrides {
            let Some(model) = model.as_object() else {
                *syncable = false;
                *blocked_reason = Some("invalidProviderDefinition");
                continue;
            };
            if !valid_provider_id(id) || !has_only_keys(model, OVERRIDE_KEYS) {
                *syncable = false;
                *blocked_reason = Some("invalidProviderDefinition");
            }
            inspect_headers(model.get("headers"), syncable, blocked_reason, warnings);
        }
    }
    models.len()
}

fn endpoint_warnings(definition: &Map<String, Value>, warnings: &mut Vec<&'static str>) {
    let Some(base_url) = definition.get("baseUrl").and_then(Value::as_str) else {
        return;
    };
    let lower = base_url.to_ascii_lowercase();
    let authority = lower
        .split_once("://")
        .map(|(_, rest)| rest.split(&['/', '?', '#'][..]).next().unwrap_or(rest))
        .unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = host_port
        .strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(host, _)| host))
        .unwrap_or_else(|| host_port.split(':').next().unwrap_or(""));
    let ipv4_loopback = host
        .parse::<std::net::Ipv4Addr>()
        .is_ok_and(|address| address.octets()[0] == 127);
    if host == "localhost" || host == "::1" || ipv4_loopback {
        push_warning(warnings, "loopbackEndpointRefersToRemoteHost");
    }
    if authority.contains('@') || base_url.contains('?') {
        push_warning(warnings, "endpointMayContainCredentials");
    }
}

fn classify_local_providers() -> Result<Vec<LocalProvider>, String> {
    let models_root = read_json_object("models.json", "localModelsInvalid")?;
    let auth_root = read_json_object("auth.json", "localAuthInvalid")?;
    classify_provider_roots(models_root, auth_root)
}

fn classify_provider_roots(
    models_root: Map<String, Value>,
    auth_root: Map<String, Value>,
) -> Result<Vec<LocalProvider>, String> {
    let providers = match models_root.get("providers") {
        None => Map::new(),
        Some(Value::Object(value)) => value.clone(),
        Some(_) => return Err(code("localModelsInvalid")),
    };
    if providers.len() > MAX_PROVIDERS {
        return Err(code("localModelsInvalid"));
    }
    let mut result = Vec::with_capacity(providers.len());
    for (id, raw_definition) in providers {
        let id_valid = valid_provider_id(&id);
        let mut definition = match raw_definition {
            Value::Object(value) => value,
            _ => {
                result.push(LocalProvider {
                    id,
                    definition: Value::Null,
                    credential: None,
                    model_count: 0,
                    syncable: false,
                    blocked_reason: Some("invalidProviderDefinition"),
                    credential_source: "none",
                    proposed_credential_action: "noCredential",
                    warnings: Vec::new(),
                });
                continue;
            }
        };
        // Remove the embedded key before applying auth.json precedence. This
        // prevents an OAuth/unknown auth entry from accidentally copying the
        // lower-priority models.json key to the remote definition.
        let embedded_api_key = definition.remove("apiKey");
        let mut syncable = id_valid;
        let mut blocked_reason = (!id_valid).then_some("invalidProviderDefinition");
        let mut warnings = Vec::new();
        let model_count = validate_model_definitions(
            &definition,
            &mut syncable,
            &mut blocked_reason,
            &mut warnings,
        );
        endpoint_warnings(&definition, &mut warnings);

        let mut credential = None;
        let (credential_source, proposed_credential_action) = if let Some(auth) = auth_root.get(&id)
        {
            match auth
                .as_object()
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
            {
                Some("api_key") => {
                    let auth_object = auth.as_object().expect("type came from an object");
                    let key = auth_object.get("key");
                    let env = auth_object.get("env");
                    let key_value = key.and_then(Value::as_str);
                    if !has_only_keys(auth_object, &["type", "key", "env"])
                        || key.is_some_and(|value| !value.is_string())
                        || key_value.is_some_and(str::is_empty)
                        || !valid_provider_env(env)
                        || key.is_none() && env.is_none()
                    {
                        syncable = false;
                        blocked_reason = Some("invalidProviderDefinition");
                        ("unknownAuth", "noCredential")
                    } else if key_value.is_some_and(|value| value.starts_with('!')) {
                        syncable = false;
                        blocked_reason = Some("commandCredentialUnsupported");
                        ("authApiKey", "noCredential")
                    } else if let Some(key_value) = key_value {
                        // Provider-scoped env may include account identifiers or
                        // additional secrets. V1.1 approves only the API key, so
                        // validate env but never copy it to the remote credential.
                        if env.is_some() {
                            push_warning(&mut warnings, "providerEnvironmentNotTransferred");
                        }
                        credential = Some(json!({ "type": "api_key", "key": key_value }));
                        if is_env_reference(key_value) {
                            push_warning(&mut warnings, "environmentReferenceRequiresRemoteValue");
                            ("environmentReference", "willInstallEnvironmentReference")
                        } else {
                            ("authApiKey", "willInstallApiKey")
                        }
                    } else {
                        push_warning(&mut warnings, "providerEnvironmentNotTransferred");
                        ("providerEnvironment", "providerEnvironmentNotTransferred")
                    }
                }
                Some("oauth") => ("oauth", "oauthNotTransferable"),
                _ => ("unknownAuth", "unknownCredentialNotTransferable"),
            }
        } else if let Some(api_key) = embedded_api_key.as_ref().and_then(Value::as_str) {
            if api_key.starts_with('!') {
                syncable = false;
                blocked_reason = Some("commandCredentialUnsupported");
                ("modelsApiKey", "noCredential")
            } else {
                credential = Some(json!({ "type": "api_key", "key": api_key }));
                if is_env_reference(api_key) {
                    push_warning(&mut warnings, "environmentReferenceRequiresRemoteValue");
                    ("environmentReference", "willInstallEnvironmentReference")
                } else {
                    ("modelsApiKey", "willInstallApiKey")
                }
            }
        } else if embedded_api_key.is_some() {
            syncable = false;
            blocked_reason = Some("invalidProviderDefinition");
            ("modelsApiKey", "noCredential")
        } else {
            ("none", "noCredential")
        };

        result.push(LocalProvider {
            id,
            definition: Value::Object(definition),
            credential,
            model_count,
            syncable,
            blocked_reason,
            credential_source,
            proposed_credential_action,
            warnings,
        });
    }
    result.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(result)
}

fn read_bounded<R: Read>(mut reader: R, limit: usize) -> io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if retained.len() < limit + 1 {
            let keep = count.min(limit + 1 - retained.len());
            retained.extend_from_slice(&buffer[..keep]);
        }
    }
    Ok(retained)
}

fn launcher_error_code(value: Option<String>) -> String {
    const ALLOWED: &[&str] = &[
        "syncProtocolUnsupported",
        "syncPayloadInvalid",
        "syncPayloadTooLarge",
        "configLockTimeout",
        "remoteModelsInvalid",
        "remoteAuthInvalid",
        "remoteConfigSymlinkRejected",
        "remoteWriteFailed",
        "remoteRollbackFailed",
        "remoteRecoveryRequired",
    ];
    value
        .filter(|code| ALLOWED.contains(&code.as_str()))
        .unwrap_or_else(|| code("syncPayloadInvalid"))
}

fn valid_warning(value: &str) -> bool {
    matches!(
        value,
        "environmentReferenceRequiresRemoteValue"
            | "loopbackEndpointRefersToRemoteHost"
            | "endpointMayContainCredentials"
            | "literalHeaderValuesTransferred"
            | "environmentHeaderRequiresRemoteValue"
            | "remoteProviderWillBeReplaced"
            | "remoteCredentialPreserved"
            | "providerEnvironmentNotTransferred"
            | "remoteReloadRequired"
    )
}

fn valid_credential_action(value: &str) -> bool {
    matches!(
        value,
        "willInstallApiKey"
            | "willInstallEnvironmentReference"
            | "remoteCredentialPreserved"
            | "providerEnvironmentNotTransferred"
            | "noCredential"
    )
}

/// True when the remote launcher rejected `--provider-sync` because it predates
/// the capability. The launcher's mode dispatch is the authority: an unknown
/// mode prints `invalid launcher mode` on stderr and exits 64. Exit 64 alone is
/// not enough — the current launcher also uses it for
/// `provider_sync_invalid_arguments`, which is a backend defect rather than an
/// out-of-date remote host.
fn is_unsupported_launcher_mode(exit_code: Option<i32>, stderr: &str) -> bool {
    exit_code == Some(64) && stderr.to_ascii_lowercase().contains("invalid launcher mode")
}

fn execute_launcher(profile: &RemotePiProfile, request: &[u8]) -> Result<LauncherResponse, String> {
    if request.len() > MAX_SYNC_BYTES {
        return Err(code("syncPayloadTooLarge"));
    }
    let LaunchSpec {
        program,
        args,
        cwd,
        env,
        create_no_window,
    } = remote_profiles::ssh_provider_sync_spec(profile);
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    for (name, value) in env {
        command.env_remove(&name);
        if let Some(value) = value {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    if create_no_window {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = create_no_window;

    let mut child = command.spawn().map_err(|_| code("ssh_spawn_failed"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| code("launcherSyncUnsupported"))?;
    let input = Zeroizing::new(request.to_vec());
    let writer = thread::spawn(move || -> Result<(), ()> {
        stdin.write_all(&input).map_err(|_| ())?;
        stdin.flush().map_err(|_| ())
    });
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| code("launcherSyncUnsupported"))?;
    let output_reader = thread::spawn(move || read_bounded(stdout, MAX_SYNC_OUTPUT_BYTES));
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| code("launcherSyncUnsupported"))?;
    let error_reader = thread::spawn(move || read_bounded(stderr, 64 * 1024));

    let deadline = Instant::now() + SSH_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = writer.join();
                let _ = output_reader.join();
                let _ = error_reader.join();
                return Err(code("ssh_timeout"));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(code("ssh_failed"));
            }
        }
    };
    if !matches!(writer.join(), Ok(Ok(()))) {
        return Err(code("ssh_failed"));
    }
    let output = output_reader
        .join()
        .map_err(|_| code("launcherSyncUnsupported"))?
        .map_err(|_| code("launcherSyncUnsupported"))?;
    let error_output = error_reader
        .join()
        .map_err(|_| code("launcherSyncUnsupported"))?
        .map_err(|_| code("launcherSyncUnsupported"))?;
    if !status.success() {
        let stderr = String::from_utf8_lossy(&error_output);
        // A launcher installed before provider-sync existed rejects the mode in
        // its shell preamble with exactly `invalid launcher mode` and exit 64 —
        // every profile enrolled before this feature is in that state, so this
        // is the first branch a real user hits. Matching anything else lets it
        // fall through to classify_transport_failure's `ssh_failed` default,
        // which sends the user to debug SSH instead of reinstalling the
        // launcher. `unsupported launcher mode` is not a string the launcher
        // has ever printed.
        if is_unsupported_launcher_mode(status.code(), &stderr) {
            return Err(code("launcherSyncUnsupported"));
        }
        return Err(code(remote_profiles::ssh_transport_error_code(
            status.code(),
            stderr.trim(),
            &profile.launcher_path,
        )));
    }
    if output.len() > MAX_SYNC_OUTPUT_BYTES {
        return Err(code("syncPayloadTooLarge"));
    }
    let response: LauncherResponse =
        serde_json::from_slice(&output).map_err(|_| code("syncPayloadInvalid"))?;
    if !response.ok {
        if response.providers.is_some() {
            return Err(code("syncPayloadInvalid"));
        }
        return Err(launcher_error_code(response.error_code));
    }
    if response.error_code.is_some() {
        return Err(code("syncPayloadInvalid"));
    }
    if let Some(providers) = &response.providers {
        if providers.len() > MAX_PROVIDERS {
            return Err(code("syncPayloadInvalid"));
        }
        let mut seen = HashSet::new();
        for provider in providers {
            if !valid_provider_id(&provider.provider_id) || !seen.insert(&provider.provider_id) {
                return Err(code("syncPayloadInvalid"));
            }
            if let Some(action) = &provider.credential_action {
                if !valid_credential_action(action) {
                    return Err(code("syncPayloadInvalid"));
                }
            }
            if provider
                .warnings
                .iter()
                .any(|warning| !valid_warning(warning))
            {
                return Err(code("syncPayloadInvalid"));
            }
        }
    }
    Ok(response)
}

fn valid_provider_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PROVIDER_ID_BYTES
        && !value.chars().any(char::is_control)
        && !matches!(value, "__proto__" | "prototype" | "constructor")
}

fn plan_key(profile_id: &str, provider_ids: &[String]) -> String {
    format!("{}\u{1f}{}", profile_id, provider_ids.join("\u{1e}"))
}

fn profile_same(left: &RemotePiProfile, right: &RemotePiProfile) -> bool {
    left.id == right.id
        && left.revision == right.revision
        && left.name == right.name
        && left.ssh_host == right.ssh_host
        && left.remote_cwd == right.remote_cwd
        && left.pi_executable == right.pi_executable
        && left.launcher_path == right.launcher_path
        && left.launcher_protocol_version == right.launcher_protocol_version
        && left.lifecycle == right.lifecycle
}

#[tauri::command]
pub fn remote_provider_sync_candidates() -> Result<Vec<ProviderSyncCandidate>, String> {
    Ok(classify_local_providers()?
        .into_iter()
        .map(|provider| ProviderSyncCandidate {
            provider_id: provider.id,
            model_count: provider.model_count,
            syncable: provider.syncable,
            blocked_reason: provider.blocked_reason,
            credential_source: provider.credential_source,
            warnings: provider.warnings,
        })
        .collect())
}

#[tauri::command]
pub fn remote_provider_sync_prepare(
    state: tauri::State<'_, RemoteProviderSyncState>,
    profile_id: String,
    provider_ids: Vec<String>,
) -> Result<PreparedProviderSync, String> {
    let provider_ids = canonical_provider_ids(provider_ids)?;
    let profile =
        remote_profiles::load_profile(&profile_id).map_err(|_| code("remoteProfileNotFound"))?;
    let local = classify_local_providers()?;
    let by_id: HashMap<_, _> = local
        .into_iter()
        .map(|provider| (provider.id.clone(), provider))
        .collect();
    let mut selected = Vec::with_capacity(provider_ids.len());
    for id in &provider_ids {
        let provider = by_id
            .get(id)
            .cloned()
            .ok_or_else(|| code("providerNotFound"))?;
        if !provider.syncable {
            return Err(code(
                provider
                    .blocked_reason
                    .unwrap_or("invalidProviderDefinition"),
            ));
        }
        selected.push(provider);
    }

    let inspect_request = serde_json::to_vec(&json!({
        "providerSyncProtocolVersion": PROVIDER_SYNC_PROTOCOL_VERSION,
        "action": "inspect",
        "providerIds": provider_ids,
    }))
    .map_err(|_| code("syncPayloadInvalid"))?;
    let inspected = execute_launcher(&profile, &inspect_request)?;
    let remote_states = inspected
        .providers
        .ok_or_else(|| code("syncPayloadInvalid"))?;
    let remote_by_id: HashMap<_, _> = remote_states
        .into_iter()
        .map(|item| (item.provider_id.clone(), item))
        .collect();
    if remote_by_id.len() != selected.len() {
        return Err(code("syncPayloadInvalid"));
    }

    let mut preview_providers = Vec::with_capacity(selected.len());
    let mut apply_providers = Vec::with_capacity(selected.len());
    for provider in selected {
        let remote = remote_by_id
            .get(&provider.id)
            .ok_or_else(|| code("syncPayloadInvalid"))?;
        let config_exists = remote
            .config_exists
            .ok_or_else(|| code("syncPayloadInvalid"))?;
        let auth_credential_exists = remote
            .auth_credential_exists
            .ok_or_else(|| code("syncPayloadInvalid"))?;
        let embedded_api_key_exists = remote
            .embedded_api_key_exists
            .ok_or_else(|| code("syncPayloadInvalid"))?;
        if remote.config_updated.is_some() || remote.credential_action.is_some() {
            return Err(code("syncPayloadInvalid"));
        }
        let mut warnings = provider.warnings.clone();
        if config_exists {
            push_warning(&mut warnings, "remoteProviderWillBeReplaced");
        }
        let preserves_remote = auth_credential_exists || embedded_api_key_exists;
        let credential_action = if preserves_remote {
            push_warning(&mut warnings, "remoteCredentialPreserved");
            "remoteCredentialPreserved"
        } else {
            provider.proposed_credential_action
        };
        preview_providers.push(PreparedProviderSyncProvider {
            provider_id: provider.id.clone(),
            model_count: provider.model_count,
            config_action: if config_exists { "replace" } else { "create" },
            credential_action,
            warnings,
        });
        apply_providers.push(json!({
            "providerId": provider.id,
            "definition": provider.definition,
            "credential": provider.credential,
        }));
    }
    let request = serde_json::to_vec(&json!({
        "providerSyncProtocolVersion": PROVIDER_SYNC_PROTOCOL_VERSION,
        "action": "apply",
        "providers": apply_providers,
    }))
    .map_err(|_| code("syncPayloadInvalid"))?;
    if request.len() > MAX_SYNC_BYTES {
        return Err(code("syncPayloadTooLarge"));
    }
    let preview = PreparedProviderSync {
        profile_id: profile.id.clone(),
        profile_revision: profile.revision,
        destination_display_name: profile.name.clone(),
        destination_host_alias: profile.ssh_host.clone(),
        providers: preview_providers,
        expires_at: now_millis().saturating_add(PLAN_TTL.as_millis() as u64),
    };
    let key = plan_key(&profile.id, &provider_ids);
    let mut plans = lock_plans(&state)?;
    plans.retain(|_, plan| plan.expires > Instant::now());
    if plans.contains_key(&key) {
        return Err(code("syncBusy"));
    }
    if plans.len() >= MAX_ACTIVE_PLANS
        || plans.values().map(|plan| plan.request.len()).sum::<usize>() + request.len()
            > MAX_PLAN_BYTES
    {
        return Err(code("syncBusy"));
    }
    plans.insert(
        key,
        SyncPlan {
            profile,
            provider_ids,
            request: Zeroizing::new(request),
            preview: preview.clone(),
            expires: Instant::now() + PLAN_TTL,
        },
    );
    Ok(preview)
}

#[tauri::command]
pub fn remote_provider_sync_apply(
    state: tauri::State<'_, RemoteProviderSyncState>,
    profile_id: String,
    provider_ids: Vec<String>,
) -> Result<ProviderSyncResult, String> {
    let provider_ids = canonical_provider_ids(provider_ids)?;
    let key = plan_key(&profile_id, &provider_ids);
    // Removal happens before any remote access: every apply attempt is single-use.
    let plan = lock_plans(&state)?
        .remove(&key)
        .ok_or_else(|| code("syncPlanMissing"))?;
    if plan.expires <= Instant::now() {
        return Err(code("syncPlanExpired"));
    }
    if plan.provider_ids != provider_ids || plan.preview.profile_id != profile_id {
        return Err(code("syncPlanStale"));
    }
    let current =
        remote_profiles::load_profile(&profile_id).map_err(|_| code("remoteProfileNotFound"))?;
    if !profile_same(&plan.profile, &current) {
        return Err(code("remoteProfileChanged"));
    }
    let response = execute_launcher(&current, &plan.request)?;
    let providers = response
        .providers
        .ok_or_else(|| code("syncPayloadInvalid"))?;
    if providers.len() != provider_ids.len() {
        return Err(code("syncPayloadInvalid"));
    }
    let by_id: HashMap<_, _> = providers
        .into_iter()
        .map(|provider| (provider.provider_id.clone(), provider))
        .collect();
    let preview_by_id: HashMap<_, _> = plan
        .preview
        .providers
        .iter()
        .map(|provider| (provider.provider_id.as_str(), provider))
        .collect();
    let mut applied = Vec::with_capacity(provider_ids.len());
    for id in provider_ids {
        let provider = by_id.get(&id).ok_or_else(|| code("syncPayloadInvalid"))?;
        if provider.config_exists.is_some()
            || provider.auth_credential_exists.is_some()
            || provider.embedded_api_key_exists.is_some()
            || provider.config_updated != Some(true)
        {
            return Err(code("syncPayloadInvalid"));
        }
        let preview = preview_by_id
            .get(id.as_str())
            .ok_or_else(|| code("syncPlanStale"))?;
        let launcher_action = provider
            .credential_action
            .as_deref()
            .ok_or_else(|| code("syncPayloadInvalid"))?;
        let credential_action = if launcher_action == "noCredential"
            && matches!(
                preview.credential_action,
                "oauthNotTransferable"
                    | "unknownCredentialNotTransferable"
                    | "providerEnvironmentNotTransferred"
            ) {
            preview.credential_action
        } else {
            launcher_action
        };
        let mut warnings = preview
            .warnings
            .iter()
            .map(|warning| (*warning).to_owned())
            .collect::<Vec<_>>();
        for warning in &provider.warnings {
            if !warnings.contains(warning) {
                warnings.push(warning.clone());
            }
        }
        applied.push(AppliedProviderSyncProvider {
            provider_id: id,
            config_updated: true,
            credential_action: credential_action.to_owned(),
            warnings,
        });
    }
    Ok(ProviderSyncResult {
        profile_id,
        providers: applied,
        reload_required: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_selection_is_sorted_and_rejects_unsafe_ids() {
        assert_eq!(
            canonical_provider_ids(vec!["z".into(), "a".into()]).unwrap(),
            vec!["a", "z"]
        );
        assert_eq!(
            canonical_provider_ids(vec!["a".into(), "a".into()]).unwrap_err(),
            "providerIdDuplicate"
        );
        assert_eq!(
            canonical_provider_ids(vec!["__proto__".into()]).unwrap_err(),
            "providerIdInvalid"
        );
    }

    #[test]
    fn provider_sync_ssh_argv_is_fixed_and_secret_free() {
        let profile = RemotePiProfile {
            id: "remote-test".into(),
            revision: 1,
            name: "Test".into(),
            ssh_host: "host-alias".into(),
            remote_cwd: Some("/srv/work".into()),
            pi_executable: None,
            launcher_path: "/home/me/.local/bin/pi-desktop-launcher".into(),
            launcher_protocol_version: 1,
            lifecycle: "attached".into(),
        };
        let spec = remote_profiles::ssh_provider_sync_spec(&profile);
        let args: Vec<_> = spec
            .args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args.last().map(String::as_str), Some("--provider-sync"));
        assert!(args.iter().any(|arg| arg == "host-alias"));
        assert!(!args.join(" ").contains("providerId"));
        assert!(!args.join(" ").contains("secret"));
    }

    #[test]
    fn credential_precedence_never_leaks_embedded_keys() {
        let models = json!({
            "providers": {
                "oauth-provider": {
                    "baseUrl": "https://example.invalid",
                    "api": "openai-completions",
                    "apiKey": "LOWER_PRIORITY_SECRET",
                    "models": [{ "id": "model" }]
                },
                "malformed-api-key-provider": {
                    "baseUrl": "https://example.invalid",
                    "api": "openai-completions",
                    "models": [{ "id": "model" }]
                },
                "provider-env-only": {
                    "baseUrl": "https://example.invalid",
                    "api": "openai-completions",
                    "models": [{ "id": "model" }]
                },
                "provider-key-and-env": {
                    "baseUrl": "https://example.invalid",
                    "api": "openai-completions",
                    "models": [{ "id": "model" }]
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let auth = json!({
            "oauth-provider": { "type": "oauth", "access": "OAUTH_SECRET" },
            "malformed-api-key-provider": {
                "type": "api_key",
                "key": "API_SECRET",
                "unexpected": "MUST_NOT_TRANSFER"
            },
            "provider-env-only": {
                "type": "api_key",
                "env": { "ACCOUNT_ID": "LOCAL_ACCOUNT", "API_TOKEN": "LOCAL_SECRET" }
            },
            "provider-key-and-env": {
                "type": "api_key",
                "key": "API_SECRET",
                "env": { "ACCOUNT_ID": "LOCAL_ACCOUNT" }
            }
        })
        .as_object()
        .unwrap()
        .clone();

        let providers = classify_provider_roots(models, auth).unwrap();
        let oauth = providers
            .iter()
            .find(|provider| provider.id == "oauth-provider")
            .unwrap();
        assert!(oauth.credential.is_none());
        assert_eq!(oauth.credential_source, "oauth");
        assert!(oauth.definition.get("apiKey").is_none());

        let malformed = providers
            .iter()
            .find(|provider| provider.id == "malformed-api-key-provider")
            .unwrap();
        assert!(!malformed.syncable);
        assert!(malformed.credential.is_none());

        let env_only = providers
            .iter()
            .find(|provider| provider.id == "provider-env-only")
            .unwrap();
        assert!(env_only.syncable);
        assert_eq!(env_only.credential_source, "providerEnvironment");
        assert_eq!(
            env_only.proposed_credential_action,
            "providerEnvironmentNotTransferred"
        );
        assert!(env_only.credential.is_none());
        assert!(env_only
            .warnings
            .contains(&"providerEnvironmentNotTransferred"));

        let key_and_env = providers
            .iter()
            .find(|provider| provider.id == "provider-key-and-env")
            .unwrap();
        assert!(key_and_env.syncable);
        assert_eq!(
            key_and_env.credential,
            Some(json!({ "type": "api_key", "key": "API_SECRET" }))
        );
        assert!(key_and_env
            .warnings
            .contains(&"providerEnvironmentNotTransferred"));
    }

    #[test]
    fn empty_or_malformed_local_api_key_credentials_fail_closed() {
        let models = json!({
            "providers": {
                "selected": { "api": "openai-completions", "models": [] }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        for credential in [
            json!({ "type": "api_key" }),
            json!({ "type": "api_key", "key": "" }),
            json!({ "type": "api_key", "env": {} }),
            json!({ "type": "api_key", "env": { "bad name": "value" } }),
            json!({ "type": "api_key", "env": { "ACCOUNT_ID": "" } }),
        ] {
            let auth = json!({ "selected": credential })
                .as_object()
                .unwrap()
                .clone();
            let providers = classify_provider_roots(models.clone(), auth).unwrap();
            assert!(!providers[0].syncable);
            assert!(providers[0].credential.is_none());
        }
    }

    #[test]
    fn launcher_response_values_are_allowlisted() {
        assert_eq!(
            launcher_error_code(Some("remoteWriteFailed".into())),
            "remoteWriteFailed"
        );
        assert_eq!(
            launcher_error_code(Some("secret from remote".into())),
            "syncPayloadInvalid"
        );
        assert!(valid_credential_action("remoteCredentialPreserved"));
        assert!(valid_credential_action("providerEnvironmentNotTransferred"));
        assert!(!valid_credential_action("REMOTE_SECRET"));
        assert!(valid_warning("remoteReloadRequired"));
        assert!(valid_warning("providerEnvironmentNotTransferred"));
        assert!(!valid_warning("REMOTE_SECRET"));
    }

    #[test]
    fn preview_serialization_contains_no_payload_fields() {
        let preview = PreparedProviderSync {
            profile_id: "remote-test".into(),
            profile_revision: 1,
            destination_display_name: "Test".into(),
            destination_host_alias: "host".into(),
            providers: vec![PreparedProviderSyncProvider {
                provider_id: "custom".into(),
                model_count: 1,
                config_action: "create",
                credential_action: "willInstallApiKey",
                warnings: vec![],
            }],
            expires_at: 1,
        };
        let value = serde_json::to_string(&preview).unwrap();
        assert!(!value.contains("definition"));
        assert!(!value.contains("credential\""));
        assert!(!value.contains("apiKey"));
    }

    #[test]
    fn an_out_of_date_launcher_is_reported_as_unsupported_not_as_ssh_failure() {
        // The exact stderr/exit pair a pre-provider-sync launcher produces.
        assert!(is_unsupported_launcher_mode(
            Some(64),
            "invalid launcher mode\n"
        ));
        // The current launcher's own argument guard shares exit 64 but is a
        // backend defect, so it must keep falling through to SSH classification.
        assert!(!is_unsupported_launcher_mode(
            Some(64),
            "provider_sync_invalid_arguments\n"
        ));
        // Real transport failures must not be relabelled as an old launcher.
        assert!(!is_unsupported_launcher_mode(
            Some(255),
            "Permission denied (publickey)."
        ));
        assert!(!is_unsupported_launcher_mode(None, "invalid launcher mode"));
        // Without the fix this is what the UI actually received.
        assert_eq!(
            remote_profiles::ssh_transport_error_code(
                Some(64),
                "invalid launcher mode",
                "/home/me/.local/bin/pi-desktop-launcher"
            ),
            "ssh_failed"
        );
    }
}
