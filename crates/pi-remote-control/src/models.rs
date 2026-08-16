//! Redacted remote model catalog.
//!
//! The host owns `~/.pi/agent/models.json` (provider credentials and base
//! URLs). Mobile clients only ever see redacted model metadata through the
//! gateway routes; this module translates the host file into the network DTOs
//! and keeps the remote allowlist in gateway storage so a mobile device can
//! never read or mutate provider credentials.
//!
//! `discover` queries an already-configured provider with host-held
//! credentials; `add` writes model definitions under an existing provider
//! (atomic temp+rename, mirroring the desktop settings writer); the remote
//! allowlist lives in the gateway SQLite (`remote_model_allowlist`) and is
//! idempotent by model ref.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const MAX_MODELS_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_MODELS_PER_ADD: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelDto {
    #[serde(rename = "ref")]
    pub model_ref: String,
    pub provider: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub display_name: Option<String>,
    pub reasoning: bool,
    #[serde(rename = "inputKinds")]
    pub input_kinds: Vec<RemoteModelInputKind>,
    #[serde(
        rename = "contextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window: Option<u64>,
    pub available: bool,
    #[serde(rename = "remoteAllowed")]
    pub remote_allowed: bool,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelCatalogResponse {
    pub models: Vec<RemoteModelDto>,
    #[serde(
        rename = "defaultModelRef",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub default_model_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelDiscoverRequest {
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelCandidate {
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(
        rename = "displayName",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub display_name: Option<String>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(rename = "inputKinds", default)]
    pub input_kinds: Vec<RemoteModelInputKind>,
    #[serde(
        rename = "contextWindow",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelDiscoverResponse {
    pub provider: String,
    pub candidates: Vec<RemoteModelCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelAddRequest {
    pub provider: String,
    pub models: Vec<RemoteModelCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelAddResponse {
    pub models: Vec<RemoteModelDto>,
    pub added: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelEnableRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteModelEnableResponse {
    #[serde(rename = "ref")]
    pub model_ref: String,
    #[serde(rename = "remoteAllowed")]
    pub remote_allowed: bool,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteModelInputKind {
    Text,
    Image,
}

/// Raw shape of `models.json` as written by the desktop host. Credentials
/// are parsed but never serialized into network DTOs.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelsJson {
    #[serde(default)]
    providers: std::collections::BTreeMap<String, ProviderEntry>,
}

/// Provider entries carry credentials (baseUrl/api/apiKey) plus models.
/// `flatten` keeps arbitrary credential keys without a fixed schema; these
/// fields are never surfaced on the wire. Note: `deny_unknown_fields` is
/// intentionally absent here because serde does not support combining it
/// with `flatten`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProviderEntry {
    #[serde(default)]
    models: Vec<ModelEntry>,
    #[serde(flatten)]
    _credentials: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelEntry {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<serde_json::Value>>,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, serde_json::Value>,
}

/// Host-owned models.json access with redaction guarantees.
pub struct HostModelCatalog {
    models_json_path: PathBuf,
    default_provider: String,
    default_model_id: String,
}

#[derive(Debug)]
pub enum ModelCatalogError {
    Unavailable,
    ProviderNotFound,
    InvalidFile,
    InvalidPayload,
    TooLarge,
}

impl std::fmt::Display for ModelCatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => "model catalog is unavailable",
            Self::ProviderNotFound => "provider is not configured",
            Self::InvalidFile => "model catalog file is invalid",
            Self::InvalidPayload => "model payload is invalid",
            Self::TooLarge => "model payload is too large",
        })
    }
}

impl std::error::Error for ModelCatalogError {}

impl HostModelCatalog {
    /// `models_json_path` may be `None` when the host cannot resolve pi's
    /// config location; the catalog then reports unavailable fail-closed.
    pub fn new(
        models_json_path: Option<PathBuf>,
        default_provider: String,
        default_model_id: String,
    ) -> Option<Self> {
        Some(Self {
            models_json_path: models_json_path?,
            default_provider,
            default_model_id,
        })
    }

    fn read(&self) -> Result<ModelsJson, ModelCatalogError> {
        let path = &self.models_json_path;
        if !path.is_file() {
            return Ok(ModelsJson {
                providers: Default::default(),
            });
        }
        let content = fs::read_to_string(path).map_err(|_| ModelCatalogError::Unavailable)?;
        if content.len() > MAX_MODELS_JSON_BYTES {
            return Err(ModelCatalogError::TooLarge);
        }
        serde_json::from_str(&content).map_err(|_| ModelCatalogError::InvalidFile)
    }

    /// Redacted listing. Never touches provider credentials.
    pub fn list(&self, allowlist: &ModelAllowlist) -> Result<RemoteModelCatalogResponse, ModelCatalogError> {
        let file = self.read()?;
        let default_ref = if self.default_provider.is_empty() || self.default_model_id.is_empty() {
            None
        } else {
            Some(format!(
                "{}/{}",
                self.default_provider, self.default_model_id
            ))
        };
        let mut models = Vec::new();
        for (provider, entry) in &file.providers {
            for model in &entry.models {
                let model_ref = format!("{provider}/{}", model.id);
                let allowed = allowlist.is_allowed(&model_ref);
                models.push(RemoteModelDto {
                    model_ref: model_ref.clone(),
                    provider: provider.clone(),
                    model_id: model.id.clone(),
                    display_name: model.name.clone(),
                    reasoning: model.reasoning,
                    input_kinds: input_kinds_of(model),
                    context_window: model.context_window,
                    available: true,
                    remote_allowed: allowed,
                    is_default: Some(model_ref.as_str()) == default_ref.as_deref(),
                });
            }
        }
        Ok(RemoteModelCatalogResponse {
            models,
            default_model_ref: default_ref,
        })
    }

    /// Queries an already-configured provider with host-held credentials.
    pub fn discover(
        &self,
        provider: &str,
    ) -> Result<RemoteModelDiscoverResponse, ModelCatalogError> {
        let file = self.read()?;
        let entry = file
            .providers
            .get(provider)
            .ok_or(ModelCatalogError::ProviderNotFound)?;
        let candidates = entry
            .models
            .iter()
            .map(|model| RemoteModelCandidate {
                model_id: model.id.clone(),
                display_name: model.name.clone(),
                reasoning: model.reasoning,
                input_kinds: input_kinds_of(model),
                context_window: model.context_window,
            })
            .collect();
        Ok(RemoteModelDiscoverResponse {
            provider: provider.to_owned(),
            candidates,
        })
    }

    /// Adds model definitions under an existing provider and persists
    /// atomically. Provider creation and credential edits stay desktop-only.
    pub fn add(
        &self,
        provider: &str,
        models: &[RemoteModelCandidate],
        allowlist: &ModelAllowlist,
    ) -> Result<RemoteModelAddResponse, ModelCatalogError> {
        if models.is_empty() || models.len() > MAX_MODELS_PER_ADD {
            return Err(ModelCatalogError::InvalidPayload);
        }
        let mut file = self.read()?;
        let entry = file
            .providers
            .get_mut(provider)
            .ok_or(ModelCatalogError::ProviderNotFound)?;
        let mut added = Vec::new();
        for candidate in models {
            if candidate.model_id.is_empty()
                || candidate.model_id.len() > 128
                || candidate.model_id.contains('/')
            {
                return Err(ModelCatalogError::InvalidPayload);
            }
            let model = ModelEntry {
                id: candidate.model_id.clone(),
                name: candidate.display_name.clone(),
                reasoning: candidate.reasoning,
                context_window: candidate.context_window,
                input: candidate
                    .input_kinds
                    .iter()
                    .map(|kind| {
                        serde_json::json!(match kind {
                            RemoteModelInputKind::Text => "text",
                            RemoteModelInputKind::Image => "image",
                        })
                    })
                    .collect::<Vec<_>>()
                    .into(),
                extra: Default::default(),
            };
            if entry.models.iter().any(|m| m.id == candidate.model_id) {
                continue;
            }
            entry.models.push(model);
            added.push(format!("{provider}/{}", candidate.model_id));
        }
        let content = serde_json::to_string_pretty(&file)
            .map_err(|_| ModelCatalogError::InvalidPayload)?;
        write_atomic(&self.models_json_path, &content)?;
        let mut models = Vec::new();
        for (provider_id, entry) in &file.providers {
            for model in &entry.models {
                let model_ref = format!("{provider_id}/{}", model.id);
                models.push(RemoteModelDto {
                    model_ref: model_ref.clone(),
                    provider: provider_id.clone(),
                    model_id: model.id.clone(),
                    display_name: model.name.clone(),
                    reasoning: model.reasoning,
                    input_kinds: input_kinds_of(model),
                    context_window: model.context_window,
                    available: true,
                    remote_allowed: allowlist.is_allowed(&model_ref),
                    is_default: false,
                });
            }
        }
        Ok(RemoteModelAddResponse { models, added })
    }
}

fn input_kinds_of(model: &ModelEntry) -> Vec<RemoteModelInputKind> {
    let Some(input) = &model.input else {
        return vec![RemoteModelInputKind::Text];
    };
    let mut kinds = Vec::new();
    for value in input {
        match value.as_str() {
            Some("image") if !kinds.contains(&RemoteModelInputKind::Image) => {
                kinds.push(RemoteModelInputKind::Image);
            }
            _ => {}
        }
    }
    if kinds.is_empty() {
        kinds.push(RemoteModelInputKind::Text);
    }
    kinds
}

fn write_atomic(path: &Path, content: &str) -> Result<(), ModelCatalogError> {
    let parent = path.parent().ok_or(ModelCatalogError::Unavailable)?;
    fs::create_dir_all(parent).map_err(|_| ModelCatalogError::Unavailable)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|_| ModelCatalogError::Unavailable)?;
    fs::rename(&tmp, path).map_err(|_| ModelCatalogError::Unavailable)
}

/// Gateway-owned remote allowlist, backed by SQLite so mobile can toggle a
/// model's remote usability without touching the host credentials file.
///
/// Semantics: host-configured models are usable remotely by default — the
/// desktop writing a model into `models.json` is the consent. The allowlist
/// only records explicit overrides (`remote-enable false` disables, `true`
/// re-enables). A model that does not exist in the catalog is rejected at
/// the route layer before any delivery, so this default cannot widen the
/// usable set beyond what the host configured.
pub struct ModelAllowlist {
    allowlist: std::collections::HashMap<String, bool>,
}

impl ModelAllowlist {
    pub fn new(entries: impl IntoIterator<Item = (String, bool)>) -> Self {
        Self {
            allowlist: entries.into_iter().collect(),
        }
    }

    pub fn is_allowed(&self, model_ref: &str) -> bool {
        self.allowlist.get(model_ref).copied().unwrap_or(true)
    }
}
