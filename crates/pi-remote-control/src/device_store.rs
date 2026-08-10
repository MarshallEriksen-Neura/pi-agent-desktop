use crate::principal::Principal;
use crate::protocol::PairingDeviceMetadata;
use crate::storage::StoredDevice;
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::Mutex;
use subtle::ConstantTimeEq;

pub const MAX_PAIRED_DEVICES: usize = 8;
pub const MAX_CONNECTIONS_PER_DEVICE: usize = 2;
pub const MAX_AUTHENTICATED_CONNECTIONS: usize = 16;

#[derive(Clone, PartialEq, Eq)]
pub struct RegisteredDevice {
    pub device_id: String,
    pub token: String,
    pub identity_epoch: u64,
}

impl fmt::Debug for RegisteredDevice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegisteredDevice")
            .field("device_id", &self.device_id)
            .field("token", &"<redacted>")
            .field("identity_epoch", &self.identity_epoch)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevocationResult {
    pub device_id: String,
    pub closed_connection_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceStoreError {
    Capacity,
    EntropyUnavailable,
    InvalidDeviceId,
    InvalidConnectionId,
    NotFound,
    AuthenticationFailed,
    IdentityEpochMismatch,
    ConnectionLimit,
    StoreUnavailable,
}

impl fmt::Display for DeviceStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("device authentication or registry operation failed")
    }
}

impl std::error::Error for DeviceStoreError {}

#[derive(Clone)]
struct DeviceRecord {
    metadata: PairingDeviceMetadata,
    token_hash: [u8; 32],
    identity_epoch: u64,
    paired_at_ms: u64,
    active_connections: BTreeSet<String>,
}

struct DeviceStoreInner {
    identity_epoch: u64,
    devices: HashMap<String, DeviceRecord>,
}

pub struct DeviceRegistry {
    rng: SystemRandom,
    inner: Mutex<DeviceStoreInner>,
}

impl Default for DeviceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl DeviceRegistry {
    pub fn new() -> Self {
        Self {
            rng: SystemRandom::new(),
            inner: Mutex::new(DeviceStoreInner {
                identity_epoch: 1,
                devices: HashMap::new(),
            }),
        }
    }

    pub fn identity_epoch(&self) -> Result<u64, DeviceStoreError> {
        Ok(self.lock_inner()?.identity_epoch)
    }

    pub fn restore_identity_epoch(&self, identity_epoch: u64) -> Result<(), DeviceStoreError> {
        if identity_epoch == 0 {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        let mut inner = self.lock_inner()?;
        if !inner.devices.is_empty() && inner.identity_epoch != identity_epoch {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        inner.identity_epoch = identity_epoch;
        Ok(())
    }

    pub fn restore_device(&self, stored: StoredDevice) -> Result<(), DeviceStoreError> {
        if stored.identity_epoch == 0 {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        let metadata = PairingDeviceMetadata {
            device_id: stored.device_id.clone(),
            display_name: stored.display_name,
            platform: match stored.platform.as_str() {
                "ios" => crate::protocol::PairingDevicePlatform::Ios,
                "android" => crate::protocol::PairingDevicePlatform::Android,
                "desktop" => crate::protocol::PairingDevicePlatform::Desktop,
                _ => crate::protocol::PairingDevicePlatform::Unknown,
            },
            app_version: None,
        };
        validate_metadata(&metadata)?;
        let mut inner = self.lock_inner()?;
        if inner.identity_epoch != stored.identity_epoch {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        if inner.devices.len() >= MAX_PAIRED_DEVICES
            && !inner.devices.contains_key(&stored.device_id)
        {
            return Err(DeviceStoreError::Capacity);
        }
        inner.devices.insert(
            stored.device_id,
            DeviceRecord {
                metadata,
                token_hash: stored.token_hash,
                identity_epoch: stored.identity_epoch,
                paired_at_ms: 0,
                active_connections: BTreeSet::new(),
            },
        );
        Ok(())
    }

    pub fn stored_device(&self, device_id: &str) -> Result<StoredDevice, DeviceStoreError> {
        let inner = self.lock_inner()?;
        let record = inner
            .devices
            .get(device_id)
            .ok_or(DeviceStoreError::NotFound)?;
        Ok(StoredDevice {
            device_id: device_id.to_owned(),
            token_hash: record.token_hash,
            display_name: record.metadata.display_name.clone(),
            platform: platform_name(&record.metadata.platform).to_owned(),
            identity_epoch: record.identity_epoch,
        })
    }

    pub fn register(
        &self,
        metadata: PairingDeviceMetadata,
        paired_at_ms: u64,
    ) -> Result<RegisteredDevice, DeviceStoreError> {
        let epoch = self.identity_epoch()?;
        self.register_for_epoch(metadata, paired_at_ms, epoch)
    }

    pub fn register_for_epoch(
        &self,
        mut metadata: PairingDeviceMetadata,
        paired_at_ms: u64,
        expected_epoch: u64,
    ) -> Result<RegisteredDevice, DeviceStoreError> {
        validate_metadata(&metadata)?;
        let mut inner = self.lock_inner()?;
        if inner.identity_epoch != expected_epoch {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        if inner.devices.len() >= MAX_PAIRED_DEVICES {
            return Err(DeviceStoreError::Capacity);
        }
        let device_id = self.random_id("device")?;
        let token = self.random_token()?;
        let token_hash = hash_token(&token);
        let identity_epoch = inner.identity_epoch;
        metadata.device_id = device_id.clone();
        inner.devices.insert(
            device_id.clone(),
            DeviceRecord {
                metadata,
                token_hash,
                identity_epoch,
                paired_at_ms,
                active_connections: BTreeSet::new(),
            },
        );
        Ok(RegisteredDevice {
            device_id,
            token,
            identity_epoch,
        })
    }

    pub fn authenticate(
        &self,
        device_id: &str,
        token: &str,
        identity_epoch: u64,
    ) -> Result<Principal, DeviceStoreError> {
        let inner = self.lock_inner()?;
        if identity_epoch != inner.identity_epoch {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        let record = inner
            .devices
            .get(device_id)
            .ok_or(DeviceStoreError::AuthenticationFailed)?;
        if record.identity_epoch != identity_epoch
            || hash_token(token)
                .as_ref()
                .ct_eq(&record.token_hash)
                .unwrap_u8()
                != 1
        {
            return Err(DeviceStoreError::AuthenticationFailed);
        }
        Principal::v1(device_id.to_owned(), identity_epoch)
            .map_err(|_| DeviceStoreError::AuthenticationFailed)
    }

    /// Validate a previously authenticated principal against the live device
    /// registry. A `Principal` is an owner/scope snapshot, not a revocation
    /// proof; gateway handlers must call this guard for every request and
    /// event replay after extracting the connection credential.
    pub fn validate_principal(&self, principal: &Principal) -> Result<(), DeviceStoreError> {
        let inner = self.lock_inner()?;
        if principal.identity_epoch() != inner.identity_epoch {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        let record = inner
            .devices
            .get(principal.device_id())
            .ok_or(DeviceStoreError::AuthenticationFailed)?;
        if record.identity_epoch != principal.identity_epoch() {
            return Err(DeviceStoreError::AuthenticationFailed);
        }
        Ok(())
    }

    pub fn open_connection(
        &self,
        principal: &Principal,
        connection_id: &str,
    ) -> Result<(), DeviceStoreError> {
        validate_connection_id(connection_id)?;
        let mut inner = self.lock_inner()?;
        if principal.identity_epoch() != inner.identity_epoch {
            return Err(DeviceStoreError::IdentityEpochMismatch);
        }
        let total_connections: usize = inner
            .devices
            .values()
            .map(|device| device.active_connections.len())
            .sum();
        let record = inner
            .devices
            .get_mut(principal.device_id())
            .ok_or(DeviceStoreError::AuthenticationFailed)?;
        if record.identity_epoch != principal.identity_epoch() {
            return Err(DeviceStoreError::AuthenticationFailed);
        }
        if !record.active_connections.contains(connection_id)
            && (record.active_connections.len() >= MAX_CONNECTIONS_PER_DEVICE
                || total_connections >= MAX_AUTHENTICATED_CONNECTIONS)
        {
            return Err(DeviceStoreError::ConnectionLimit);
        }
        record.active_connections.insert(connection_id.to_owned());
        Ok(())
    }

    pub fn close_connection(&self, device_id: &str, connection_id: &str) {
        if let Ok(mut inner) = self.lock_inner() {
            if let Some(record) = inner.devices.get_mut(device_id) {
                record.active_connections.remove(connection_id);
            }
        }
    }

    pub fn revoke(&self, device_id: &str) -> Result<RevocationResult, DeviceStoreError> {
        let mut inner = self.lock_inner()?;
        let record = inner
            .devices
            .remove(device_id)
            .ok_or(DeviceStoreError::NotFound)?;
        Ok(RevocationResult {
            device_id: device_id.to_owned(),
            closed_connection_ids: record.active_connections.into_iter().collect(),
        })
    }

    pub fn reset_identity(&self) -> Result<Vec<String>, DeviceStoreError> {
        let mut inner = self.lock_inner()?;
        inner.identity_epoch = inner.identity_epoch.saturating_add(1).max(1);
        let closed = inner
            .devices
            .values()
            .flat_map(|record| record.active_connections.iter().cloned())
            .collect();
        inner.devices.clear();
        Ok(closed)
    }

    pub fn list_devices(&self) -> Result<Vec<PairingDeviceMetadata>, DeviceStoreError> {
        let inner = self.lock_inner()?;
        let mut devices = inner
            .devices
            .values()
            .map(|record| record.metadata.clone())
            .collect::<Vec<_>>();
        devices.sort_by(|left, right| left.device_id.cmp(&right.device_id));
        Ok(devices)
    }

    pub fn paired_at_ms(&self, device_id: &str) -> Result<u64, DeviceStoreError> {
        self.lock_inner()?
            .devices
            .get(device_id)
            .map(|record| record.paired_at_ms)
            .ok_or(DeviceStoreError::NotFound)
    }

    fn random_id(&self, prefix: &str) -> Result<String, DeviceStoreError> {
        let mut bytes = [0_u8; 16];
        self.rng
            .fill(&mut bytes)
            .map_err(|_| DeviceStoreError::EntropyUnavailable)?;
        Ok(format!("{prefix}-{}", hex(&bytes)))
    }

    fn random_token(&self) -> Result<String, DeviceStoreError> {
        let mut bytes = [0_u8; 32];
        self.rng
            .fill(&mut bytes)
            .map_err(|_| DeviceStoreError::EntropyUnavailable)?;
        Ok(hex(&bytes))
    }

    fn lock_inner(&self) -> Result<std::sync::MutexGuard<'_, DeviceStoreInner>, DeviceStoreError> {
        self.inner
            .lock()
            .map_err(|_| DeviceStoreError::StoreUnavailable)
    }
}

fn validate_metadata(metadata: &PairingDeviceMetadata) -> Result<(), DeviceStoreError> {
    if metadata.display_name.is_empty()
        || metadata.display_name.len() > 256
        || metadata.display_name.chars().any(char::is_control)
    {
        return Err(DeviceStoreError::InvalidDeviceId);
    }
    if metadata.device_id.is_empty() || metadata.device_id.len() > 128 {
        return Err(DeviceStoreError::InvalidDeviceId);
    }
    Ok(())
}

fn platform_name(platform: &crate::protocol::PairingDevicePlatform) -> &'static str {
    match platform {
        crate::protocol::PairingDevicePlatform::Ios => "ios",
        crate::protocol::PairingDevicePlatform::Android => "android",
        crate::protocol::PairingDevicePlatform::Desktop => "desktop",
        crate::protocol::PairingDevicePlatform::Unknown => "unknown",
    }
}

fn validate_connection_id(value: &str) -> Result<(), DeviceStoreError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        Err(DeviceStoreError::InvalidConnectionId)
    } else {
        Ok(())
    }
}

fn hash_token(token: &str) -> [u8; 32] {
    let digest = digest(&SHA256, token.as_bytes());
    let mut output = [0_u8; 32];
    output.copy_from_slice(digest.as_ref());
    output
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
