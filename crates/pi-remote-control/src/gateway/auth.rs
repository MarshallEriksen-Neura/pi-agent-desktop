use crate::device_store::{DeviceRegistry, DeviceStoreError};
use crate::principal::Principal;
use axum::http::HeaderMap;
use std::sync::Arc;

use super::errors::GatewayError;

#[derive(Debug, Clone)]
pub struct AuthenticatedPrincipal {
    pub principal: Principal,
}

pub fn authenticate_headers(
    devices: &Arc<DeviceRegistry>,
    headers: &HeaderMap,
) -> Result<AuthenticatedPrincipal, GatewayError> {
    let device_id = headers
        .get("x-pi-device-id")
        .and_then(|value| value.to_str().ok())
        .ok_or(GatewayError::Unauthorized)?;
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(GatewayError::Unauthorized)?;
    let token = authorization
        .strip_prefix("Bearer ")
        .filter(|value| !value.is_empty())
        .ok_or(GatewayError::Unauthorized)?;
    let epoch = devices.identity_epoch().map_err(map_device_error)?;
    let principal = devices
        .authenticate(device_id, token, epoch)
        .map_err(map_device_error)?;
    devices
        .validate_principal(&principal)
        .map_err(map_device_error)?;
    Ok(AuthenticatedPrincipal { principal })
}

fn map_device_error(error: DeviceStoreError) -> GatewayError {
    match error {
        DeviceStoreError::StoreUnavailable => GatewayError::ServiceUnavailable,
        DeviceStoreError::AuthenticationFailed
        | DeviceStoreError::IdentityEpochMismatch
        | DeviceStoreError::NotFound
        | DeviceStoreError::InvalidDeviceId
        | DeviceStoreError::InvalidConnectionId
        | DeviceStoreError::Capacity
        | DeviceStoreError::ConnectionLimit
        | DeviceStoreError::EntropyUnavailable => GatewayError::Unauthorized,
    }
}
