use crate::protocol::{validate_relative_path, ValidationError, MAX_DEVICE_ID_BYTES};
use std::collections::BTreeSet;
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RemoteScope {
    ReadCapabilities,
    ReadProjects,
    CreateTasks,
    ReadOwnedTasks,
    CancelOwnedTasks,
    RespondToOwnedInteractions,
    /// Elevated, opt-in model administration: discover/add models and toggle
    /// the remote allowlist. Deliberately absent from the v1 scope set, so
    /// every newly paired device starts without it and the host grants it
    /// separately from ordinary task execution.
    ModelAdmin,
}

/// Scope and owner claims captured at authentication time. This value is not
/// a revocation proof; the live device registry must validate it per request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    device_id: String,
    identity_epoch: u64,
    scopes: BTreeSet<RemoteScope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthorizationError {
    MissingScope(RemoteScope),
    NotFound,
}

impl fmt::Display for AuthorizationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingScope(_) | Self::NotFound => write!(f, "resource is not available"),
        }
    }
}

impl std::error::Error for AuthorizationError {}

impl Principal {
    pub fn v1(device_id: impl Into<String>, identity_epoch: u64) -> Result<Self, ValidationError> {
        let device_id = device_id.into();
        if device_id.is_empty() {
            return Err(ValidationError::Empty { field: "deviceId" });
        }
        if device_id.len() > MAX_DEVICE_ID_BYTES {
            return Err(ValidationError::TooLong {
                field: "deviceId",
                max_bytes: MAX_DEVICE_ID_BYTES,
            });
        }
        if device_id.chars().any(char::is_control) {
            return Err(ValidationError::InvalidValue { field: "deviceId" });
        }
        let scopes = [
            RemoteScope::ReadCapabilities,
            RemoteScope::ReadProjects,
            RemoteScope::CreateTasks,
            RemoteScope::ReadOwnedTasks,
            RemoteScope::CancelOwnedTasks,
            RemoteScope::RespondToOwnedInteractions,
        ]
        .into_iter()
        .collect();
        Ok(Self {
            device_id,
            identity_epoch,
            scopes,
        })
    }

    pub fn restricted(
        device_id: impl Into<String>,
        identity_epoch: u64,
        scopes: impl IntoIterator<Item = RemoteScope>,
    ) -> Result<Self, ValidationError> {
        let mut principal = Self::v1(device_id, identity_epoch)?;
        principal.scopes = scopes.into_iter().collect();
        Ok(principal)
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn identity_epoch(&self) -> u64 {
        self.identity_epoch
    }

    pub fn identity_epoch_matches(&self, expected: u64) -> bool {
        self.identity_epoch == expected
    }

    pub fn has_scope(&self, scope: RemoteScope) -> bool {
        self.scopes.contains(&scope)
    }

    pub fn require(&self, scope: RemoteScope) -> Result<(), AuthorizationError> {
        if self.has_scope(scope) {
            Ok(())
        } else {
            Err(AuthorizationError::MissingScope(scope))
        }
    }

    /// Owner checks intentionally collapse "missing" and "belongs to another
    /// device" into one result. Callers can therefore authorize before looking
    /// up a task or interaction without creating an existence oracle.
    pub fn require_owner(
        &self,
        owner_device_id: &str,
        scope: RemoteScope,
    ) -> Result<(), AuthorizationError> {
        self.require(scope)?;
        if self.device_id == owner_device_id {
            Ok(())
        } else {
            Err(AuthorizationError::NotFound)
        }
    }

    pub fn owns(&self, owner_device_id: &str) -> bool {
        self.device_id == owner_device_id
    }

    pub fn validate_context_path(&self, path: &str) -> Result<(), ValidationError> {
        validate_relative_path(path)
    }
}
