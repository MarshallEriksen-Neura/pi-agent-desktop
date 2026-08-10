use crate::protocol::CertificatePin;
use rcgen::{generate_simple_self_signed, KeyPair};
use ring::digest::{digest, SHA256};
use rustls::pki_types::PrivatePkcs8KeyDer;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Mutex;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredIdentity {
    pub desktop_id: String,
    pub identity_epoch: u64,
    pub certificate_der: Vec<u8>,
    pub private_key_der: Vec<u8>,
    pub spki_sha256: String,
}

impl fmt::Debug for StoredIdentity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredIdentity")
            .field("desktop_id", &self.desktop_id)
            .field("identity_epoch", &self.identity_epoch)
            .field("certificate_der_len", &self.certificate_der.len())
            .field("private_key_der", &"<redacted>")
            .field("spki_sha256", &self.spki_sha256)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    MissingMaterial,
    CorruptMaterial,
    FingerprintMismatch,
    AlreadyInitialized,
    StoreUnavailable,
    CertificateGenerationFailed,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("remote control identity is unavailable")
    }
}

impl std::error::Error for IdentityError {}

/// A loaded certificate identity. The private key is intentionally not part
/// of Debug/Serialize output and is only exposed to the TLS composition layer
/// as a byte slice.
#[derive(Clone)]
pub struct CertificateIdentity {
    desktop_id: String,
    identity_epoch: u64,
    certificate_der: Vec<u8>,
    private_key_der: Vec<u8>,
    certificate_pin: CertificatePin,
}

impl CertificateIdentity {
    pub fn generate(
        desktop_id: impl Into<String>,
        identity_epoch: u64,
        subject_alt_names: Vec<String>,
    ) -> Result<Self, IdentityError> {
        let desktop_id = desktop_id.into();
        if desktop_id.is_empty()
            || desktop_id.len() > 128
            || desktop_id.chars().any(char::is_control)
            || identity_epoch == 0
        {
            return Err(IdentityError::CertificateGenerationFailed);
        }
        if subject_alt_names.is_empty()
            || subject_alt_names.iter().any(|name| {
                name.is_empty() || name.len() > 256 || name.chars().any(char::is_control)
            })
        {
            return Err(IdentityError::CertificateGenerationFailed);
        }
        let certified = generate_simple_self_signed(subject_alt_names)
            .map_err(|_| IdentityError::CertificateGenerationFailed)?;
        let certificate_der = certified.cert.der().to_vec();
        let private_key_der = certified.key_pair.serialize_der();
        let spki_sha256 = fingerprint(&certified.key_pair.public_key_der());
        Ok(Self {
            desktop_id,
            identity_epoch,
            certificate_der,
            private_key_der,
            certificate_pin: CertificatePin {
                algorithm: "spki-sha256".to_owned(),
                value: spki_sha256,
            },
        })
    }

    pub fn from_stored(stored: StoredIdentity) -> Result<Self, IdentityError> {
        if stored.certificate_der.is_empty() || stored.private_key_der.is_empty() {
            return Err(IdentityError::MissingMaterial);
        }
        if stored.spki_sha256.len() != 64 {
            return Err(IdentityError::CorruptMaterial);
        }
        if stored.desktop_id.is_empty()
            || stored.desktop_id.len() > 128
            || stored.identity_epoch == 0
        {
            return Err(IdentityError::CorruptMaterial);
        }
        let pkcs8 = PrivatePkcs8KeyDer::from(stored.private_key_der.as_slice());
        let key_pair =
            KeyPair::from_pkcs8_der_and_sign_algo(&pkcs8, &rcgen::PKCS_ECDSA_P256_SHA256)
                .map_err(|_| IdentityError::CorruptMaterial)?;
        let key_fingerprint = fingerprint(&key_pair.public_key_der());
        let certificate_spki = extract_subject_public_key_info(&stored.certificate_der)
            .ok_or(IdentityError::CorruptMaterial)?;
        let certificate_fingerprint = fingerprint(certificate_spki);
        if key_fingerprint != stored.spki_sha256 || certificate_fingerprint != key_fingerprint {
            return Err(IdentityError::FingerprintMismatch);
        }
        Ok(Self {
            desktop_id: stored.desktop_id,
            identity_epoch: stored.identity_epoch,
            certificate_der: stored.certificate_der,
            private_key_der: stored.private_key_der,
            certificate_pin: CertificatePin {
                algorithm: "spki-sha256".to_owned(),
                value: key_fingerprint,
            },
        })
    }

    pub fn stored(&self) -> StoredIdentity {
        StoredIdentity {
            desktop_id: self.desktop_id.clone(),
            identity_epoch: self.identity_epoch,
            certificate_der: self.certificate_der.clone(),
            private_key_der: self.private_key_der.clone(),
            spki_sha256: self.certificate_pin.value.clone(),
        }
    }

    pub fn certificate_der(&self) -> &[u8] {
        &self.certificate_der
    }

    pub fn private_key_der(&self) -> &[u8] {
        &self.private_key_der
    }

    pub fn certificate_pin(&self) -> &CertificatePin {
        &self.certificate_pin
    }

    pub fn desktop_id(&self) -> &str {
        &self.desktop_id
    }

    pub fn identity_epoch(&self) -> u64 {
        self.identity_epoch
    }
}

pub trait IdentityStore: Send + Sync {
    fn load(&self) -> Result<Option<StoredIdentity>, IdentityError>;
    fn save(&self, identity: &StoredIdentity) -> Result<(), IdentityError>;
    fn clear(&self) -> Result<(), IdentityError>;
}

#[derive(Default)]
pub struct InMemoryIdentityStore {
    value: Mutex<Option<StoredIdentity>>,
}

impl IdentityStore for InMemoryIdentityStore {
    fn load(&self) -> Result<Option<StoredIdentity>, IdentityError> {
        self.value
            .lock()
            .map(|value| value.clone())
            .map_err(|_| IdentityError::StoreUnavailable)
    }

    fn save(&self, identity: &StoredIdentity) -> Result<(), IdentityError> {
        self.value
            .lock()
            .map(|mut value| *value = Some(identity.clone()))
            .map_err(|_| IdentityError::StoreUnavailable)
    }

    fn clear(&self) -> Result<(), IdentityError> {
        self.value
            .lock()
            .map(|mut value| *value = None)
            .map_err(|_| IdentityError::StoreUnavailable)
    }
}

pub fn load_identity<S: IdentityStore>(store: &S) -> Result<CertificateIdentity, IdentityError> {
    let stored = store.load()?.ok_or(IdentityError::MissingMaterial)?;
    CertificateIdentity::from_stored(stored)
}

/// Initial creation and rotation are explicit local-administration actions;
/// startup uses `load_identity` and never silently trusts a newly generated
/// certificate after missing/corrupt material.
pub fn create_initial_identity<S: IdentityStore>(
    store: &S,
    desktop_id: impl Into<String>,
    subject_alt_names: Vec<String>,
) -> Result<CertificateIdentity, IdentityError> {
    if store.load()?.is_some() {
        return Err(IdentityError::AlreadyInitialized);
    }
    let identity = CertificateIdentity::generate(desktop_id, 1, subject_alt_names)?;
    store.save(&identity.stored())?;
    Ok(identity)
}

pub fn rotate_identity<S: IdentityStore>(
    store: &S,
    desktop_id: impl Into<String>,
    identity_epoch: u64,
    subject_alt_names: Vec<String>,
) -> Result<CertificateIdentity, IdentityError> {
    let identity = CertificateIdentity::generate(desktop_id, identity_epoch, subject_alt_names)?;
    store.save(&identity.stored())?;
    Ok(identity)
}

fn fingerprint(value: &[u8]) -> String {
    digest(&SHA256, value)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn extract_subject_public_key_info(certificate: &[u8]) -> Option<&[u8]> {
    let (outer_tag, outer_start, outer_end, _) = der_tlv(certificate, 0)?;
    if outer_tag != 0x30 || outer_end > certificate.len() {
        return None;
    }
    let tbs_offset = outer_start;
    let (tbs_tag, tbs_start, tbs_end, _) = der_tlv(certificate, tbs_offset)?;
    if tbs_tag != 0x30 || tbs_end > outer_end {
        return None;
    }
    let mut offset = tbs_start;
    if certificate.get(offset) == Some(&0xa0) {
        offset = der_tlv(certificate, offset)?.3;
    }
    for _ in 0..5 {
        offset = der_tlv(certificate, offset)?.3;
    }
    let (spki_tag, _spki_start, spki_end, _) = der_tlv(certificate, offset)?;
    if spki_tag != 0x30 {
        return None;
    }
    certificate.get(offset..spki_end)
}

fn der_tlv(input: &[u8], offset: usize) -> Option<(u8, usize, usize, usize)> {
    let tag = *input.get(offset)?;
    let length_byte = *input.get(offset + 1)?;
    let (length, header_len) = if length_byte & 0x80 == 0 {
        (length_byte as usize, 2)
    } else {
        let count = (length_byte & 0x7f) as usize;
        if count == 0 || count > 4 {
            return None;
        }
        let mut length = 0usize;
        for byte in input.get(offset + 2..offset + 2 + count)? {
            length = (length << 8) | (*byte as usize);
        }
        (length, 2 + count)
    };
    let start = offset + header_len;
    let end = start.checked_add(length)?;
    if end > input.len() {
        return None;
    }
    Some((tag, start, end, end))
}
