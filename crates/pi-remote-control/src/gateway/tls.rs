use crate::identity::CertificateIdentity;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use std::fmt;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsConfigError {
    InvalidIdentity,
}

impl fmt::Display for TlsConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("remote control TLS identity is invalid")
    }
}

impl std::error::Error for TlsConfigError {}

pub fn build_server_config(
    identity: &CertificateIdentity,
) -> Result<Arc<ServerConfig>, TlsConfigError> {
    let certificate = CertificateDer::from(identity.certificate_der().to_vec());
    let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        identity.private_key_der().to_vec(),
    ));
    ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], private_key)
        .map(Arc::new)
        .map_err(|_| TlsConfigError::InvalidIdentity)
}
