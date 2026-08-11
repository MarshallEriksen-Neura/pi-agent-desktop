use crate::device_store::{DeviceRegistry, DeviceStoreError};
use crate::identity::{CertificateIdentity, IdentityStore};
use crate::protocol::{
    CertificatePin, PairingDesktopIdentity, PairingFailure, PairingFailureCode, PairingQrPayload,
    PairingRequest, PairingSuccess, RemoteEndpoint, WakeOnLanConfig,
};
use ring::digest::{digest, SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use subtle::ConstantTimeEq;

pub const PAIRING_TICKET_TTL_MS: u64 = 120_000;
pub const PAIRING_SECRET_BYTES: usize = 32;
const MAX_INVALID_TICKET_ATTEMPTS: u8 = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairingError {
    InvalidTicket,
    RateLimited,
    IdentityUnavailable,
    StoreUnavailable,
}

impl fmt::Display for PairingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("pairing request could not be completed")
    }
}

impl std::error::Error for PairingError {}

#[derive(Clone)]
struct TicketRecord {
    secret_hash: [u8; 32],
    expires_at_ms: u64,
    identity_epoch: u64,
    invalid_attempts: u8,
    wake_on_lan: Option<WakeOnLanConfig>,
}

pub struct PairingManager {
    rng: SystemRandom,
    tickets: Mutex<HashMap<String, TicketRecord>>,
    devices: Arc<DeviceRegistry>,
}

impl PairingManager {
    pub fn new(devices: Arc<DeviceRegistry>) -> Self {
        Self {
            rng: SystemRandom::new(),
            tickets: Mutex::new(HashMap::new()),
            devices,
        }
    }

    pub fn issue_ticket(
        &self,
        desktop: PairingDesktopIdentity,
        endpoints: Vec<RemoteEndpoint>,
        certificate_pin: CertificatePin,
        wake_on_lan: Option<WakeOnLanConfig>,
        now_ms: u64,
    ) -> Result<PairingQrPayload, PairingError> {
        if endpoints.is_empty() || endpoints.len() > 8 {
            return Err(PairingError::IdentityUnavailable);
        }
        let pairing_id = self.random_hex(16)?;
        let secret = self.random_hex(PAIRING_SECRET_BYTES)?;
        let identity_epoch = self
            .devices
            .identity_epoch()
            .map_err(|_| PairingError::StoreUnavailable)?;
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| PairingError::StoreUnavailable)?;
        tickets.retain(|_, ticket| ticket.expires_at_ms > now_ms);
        if tickets.len() >= 64 {
            return Err(PairingError::RateLimited);
        }
        tickets.insert(
            pairing_id.clone(),
            TicketRecord {
                secret_hash: hash_secret(&secret),
                expires_at_ms: now_ms.saturating_add(PAIRING_TICKET_TTL_MS),
                identity_epoch,
                invalid_attempts: 0,
                wake_on_lan,
            },
        );
        Ok(PairingQrPayload {
            protocol: "pi.remote-control".to_owned(),
            version: 1,
            desktop,
            endpoints,
            pairing_id,
            secret,
            certificate_pin,
            expires_at: format_timestamp(now_ms.saturating_add(PAIRING_TICKET_TTL_MS)),
        })
    }

    pub fn redeem(
        &self,
        request: PairingRequest,
        now_ms: u64,
    ) -> Result<PairingSuccess, PairingError> {
        if request.version != 1 {
            return Err(PairingError::InvalidTicket);
        }
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| PairingError::StoreUnavailable)?;
        let ticket = tickets
            .get(&request.pairing_id)
            .cloned()
            .ok_or(PairingError::InvalidTicket)?;
        let secret_matches = hash_secret(&request.secret)
            .as_ref()
            .ct_eq(ticket.secret_hash.as_ref())
            .unwrap_u8()
            == 1;
        if ticket.expires_at_ms <= now_ms {
            tickets.remove(&request.pairing_id);
            return Err(PairingError::InvalidTicket);
        }
        if !secret_matches {
            let should_remove = if let Some(ticket) = tickets.get_mut(&request.pairing_id) {
                ticket.invalid_attempts = ticket.invalid_attempts.saturating_add(1);
                ticket.invalid_attempts >= MAX_INVALID_TICKET_ATTEMPTS
            } else {
                false
            };
            if should_remove {
                tickets.remove(&request.pairing_id);
            }
            return Err(PairingError::InvalidTicket);
        }
        if ticket.identity_epoch
            != self
                .devices
                .identity_epoch()
                .map_err(|_| PairingError::StoreUnavailable)?
        {
            return Err(PairingError::IdentityUnavailable);
        }
        let registered = self
            .devices
            .register_for_epoch(request.device, now_ms, ticket.identity_epoch)
            .map_err(map_device_error)?;
        tickets.remove(&request.pairing_id);
        drop(tickets);
        Ok(PairingSuccess {
            version: 1,
            device_id: registered.device_id,
            token: registered.token,
            server_time: format_timestamp(now_ms),
            wake_on_lan: ticket.wake_on_lan,
        })
    }

    pub fn redeem_response(
        &self,
        request: PairingRequest,
        now_ms: u64,
    ) -> Result<PairingSuccess, PairingFailure> {
        self.redeem(request, now_ms)
            .map_err(|error| PairingFailure {
                version: 1,
                error: match error {
                    PairingError::InvalidTicket => PairingFailureCode::InvalidTicket,
                    PairingError::RateLimited => PairingFailureCode::RateLimited,
                    PairingError::IdentityUnavailable | PairingError::StoreUnavailable => {
                        PairingFailureCode::IdentityUnavailable
                    }
                },
                retry_after_ms: None,
            })
    }

    pub fn clear_tickets(&self) -> Result<(), PairingError> {
        self.tickets
            .lock()
            .map(|mut tickets| tickets.clear())
            .map_err(|_| PairingError::StoreUnavailable)
    }

    pub fn reset_identity(&self) -> Result<Vec<String>, PairingError> {
        self.clear_tickets()?;
        self.devices
            .reset_identity()
            .map_err(|_| PairingError::StoreUnavailable)
    }

    /// Rotate the persisted TLS identity together with the authentication
    /// epoch. Authentication is invalidated before the new material is
    /// persisted, so a storage failure leaves the gateway fail-closed rather
    /// than retaining usable old credentials.
    pub fn rotate_identity<S: IdentityStore>(
        &self,
        store: &S,
        desktop_id: impl Into<String>,
        subject_alt_names: Vec<String>,
    ) -> Result<(CertificateIdentity, Vec<String>), PairingError> {
        let next_epoch = self
            .devices
            .identity_epoch()
            .map_err(|_| PairingError::StoreUnavailable)?
            .saturating_add(1)
            .max(1);
        let identity = CertificateIdentity::generate(desktop_id, next_epoch, subject_alt_names)
            .map_err(|_| PairingError::IdentityUnavailable)?;
        let closed_connection_ids = self.reset_identity()?;
        if store.save(&identity.stored()).is_err() {
            return Err(PairingError::IdentityUnavailable);
        }
        Ok((identity, closed_connection_ids))
    }

    pub fn ticket_count(&self) -> Result<usize, PairingError> {
        self.tickets
            .lock()
            .map(|tickets| tickets.len())
            .map_err(|_| PairingError::StoreUnavailable)
    }

    fn random_hex(&self, bytes: usize) -> Result<String, PairingError> {
        let mut value = vec![0_u8; bytes];
        self.rng
            .fill(&mut value)
            .map_err(|_| PairingError::IdentityUnavailable)?;
        Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
    }
}

fn map_device_error(error: DeviceStoreError) -> PairingError {
    match error {
        DeviceStoreError::Capacity => PairingError::RateLimited,
        DeviceStoreError::ConnectionLimit => PairingError::RateLimited,
        DeviceStoreError::EntropyUnavailable => PairingError::IdentityUnavailable,
        DeviceStoreError::StoreUnavailable => PairingError::StoreUnavailable,
        DeviceStoreError::InvalidDeviceId
        | DeviceStoreError::InvalidConnectionId
        | DeviceStoreError::NotFound
        | DeviceStoreError::AuthenticationFailed
        | DeviceStoreError::IdentityEpochMismatch => PairingError::InvalidTicket,
    }
}

fn hash_secret(secret: &str) -> [u8; 32] {
    let digest = digest(&SHA256, secret.as_bytes());
    let mut output = [0_u8; 32];
    output.copy_from_slice(digest.as_ref());
    output
}

fn format_timestamp(unix_ms: u64) -> String {
    let seconds = unix_ms / 1000;
    let millis = unix_ms % 1000;
    let days = seconds / 86_400;
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}
