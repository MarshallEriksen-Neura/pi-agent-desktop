use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::thread;

use pi_remote_control::config::{
    validate_selected_addresses, BindPolicyError, RemoteControlConfig,
};
use pi_remote_control::device_store::{
    DeviceRegistry, DeviceStoreError, MAX_AUTHENTICATED_CONNECTIONS, MAX_CONNECTIONS_PER_DEVICE,
    MAX_PAIRED_DEVICES,
};
use pi_remote_control::identity::{
    create_initial_identity, load_identity, rotate_identity, CertificateIdentity, IdentityError,
    InMemoryIdentityStore,
};
use pi_remote_control::pairing::PairingManager;
use pi_remote_control::protocol::{
    CertificatePin, PairingDesktopIdentity, PairingDeviceMetadata, PairingDevicePlatform,
    PairingFailureCode, PairingRequest, PairingSuccess, RemoteEndpoint, RemoteEndpointScheme,
};
use rcgen::KeyPair;
use rustls::pki_types::PrivatePkcs8KeyDer;

fn device_metadata() -> PairingDeviceMetadata {
    PairingDeviceMetadata {
        device_id: "client-instance".to_owned(),
        display_name: "Test phone".to_owned(),
        platform: PairingDevicePlatform::Ios,
        app_version: Some("1.0.0".to_owned()),
    }
}

fn issue(manager: &PairingManager, now_ms: u64) -> pi_remote_control::protocol::PairingQrPayload {
    manager
        .issue_ticket(
            PairingDesktopIdentity {
                desktop_id: "desktop-1".to_owned(),
                display_name: "Test desktop".to_owned(),
            },
            vec![RemoteEndpoint {
                scheme: RemoteEndpointScheme::Https,
                host: "192.168.1.20".to_owned(),
                port: 44321,
            }],
            CertificatePin {
                algorithm: "spki-sha256".to_owned(),
                value: "a".repeat(64),
            },
            now_ms,
        )
        .expect("issue ticket")
}

#[test]
fn bind_policy_is_disabled_by_default_and_accepts_only_private_selected_addresses() {
    assert!(!RemoteControlConfig::default().is_enabled());
    assert_eq!(
        RemoteControlConfig::try_new(true, vec![], 44321),
        Err(BindPolicyError::NoSelectedAddress)
    );
    assert_eq!(
        RemoteControlConfig::try_new(true, vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20))], 0),
        Err(BindPolicyError::InvalidPort)
    );
    let config = RemoteControlConfig::try_new(
        true,
        vec![
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            IpAddr::V6(Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1)),
        ],
        44321,
    )
    .expect("private bind configuration");
    assert_eq!(
        config
            .selected_socket_addresses()
            .expect("socket addresses")
            .len(),
        3
    );
    for address in [
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)),
        IpAddr::V6(Ipv6Addr::LOCALHOST),
        IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)),
    ] {
        assert!(validate_selected_addresses(&[address]).is_err());
    }
}

#[test]
fn identity_load_is_fail_closed_and_certificate_pin_is_stable() {
    let store = InMemoryIdentityStore::default();
    assert!(matches!(
        load_identity(&store),
        Err(IdentityError::MissingMaterial)
    ));
    let first = create_initial_identity(&store, "desktop-1", vec!["localhost".to_owned()])
        .expect("create identity");
    let loaded = load_identity(&store).expect("load identity");
    assert_eq!(first.certificate_pin(), loaded.certificate_pin());
    assert_eq!(loaded.desktop_id(), "desktop-1");
    assert_eq!(loaded.identity_epoch(), 1);
    assert!(matches!(
        create_initial_identity(&store, "desktop-1", vec!["localhost".to_owned()]),
        Err(IdentityError::AlreadyInitialized)
    ));
    let mut corrupt = loaded.stored();
    corrupt.private_key_der[0] ^= 1;
    assert!(matches!(
        CertificateIdentity::from_stored(corrupt),
        Err(IdentityError::CorruptMaterial | IdentityError::FingerprintMismatch)
    ));
    let rotated = rotate_identity(&store, "desktop-1", 2, vec!["localhost".to_owned()])
        .expect("rotate identity");
    assert_ne!(first.certificate_pin(), rotated.certificate_pin());
    assert_eq!(rotated.identity_epoch(), 2);
}

#[test]
fn pairing_ticket_is_one_use_atomic_and_device_token_is_not_reusable_after_reset() {
    let devices = Arc::new(DeviceRegistry::new());
    let manager = Arc::new(PairingManager::new(Arc::clone(&devices)));
    let payload = issue(&manager, 1_000);
    assert_eq!(payload.secret.len(), 64);
    assert_eq!(manager.ticket_count().expect("ticket count"), 1);
    let request = PairingRequest {
        version: 1,
        pairing_id: payload.pairing_id.clone(),
        secret: payload.secret.clone(),
        device: device_metadata(),
    };
    let mut workers = Vec::new();
    for _ in 0..8 {
        let manager = Arc::clone(&manager);
        let request = request.clone();
        workers.push(thread::spawn(move || {
            manager.redeem_response(request, 1_001)
        }));
    }
    let results = workers
        .into_iter()
        .map(|worker| worker.join().expect("pairing worker"))
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(results.iter().filter(|result| result.is_err()).count(), 7);
    let success = results
        .into_iter()
        .find_map(Result::ok)
        .expect("one pairing success");
    assert!(success.device_id.starts_with("device-"));
    assert_ne!(success.device_id, request.device.device_id);
    let original_epoch = devices.identity_epoch().expect("identity epoch");
    let principal = devices
        .authenticate(&success.device_id, &success.token, original_epoch)
        .expect("authenticate paired device");
    devices
        .validate_principal(&principal)
        .expect("principal is live before reset");
    devices
        .open_connection(&principal, "paired-connection")
        .expect("open paired connection");
    assert_eq!(manager.ticket_count().expect("ticket count"), 0);

    let closed = manager.reset_identity().expect("identity reset");
    assert_eq!(closed, vec!["paired-connection".to_owned()]);
    assert_eq!(
        devices.identity_epoch().expect("new identity epoch"),
        original_epoch + 1
    );
    assert_eq!(
        devices.authenticate(&success.device_id, &success.token, original_epoch),
        Err(DeviceStoreError::IdentityEpochMismatch)
    );
    assert_eq!(
        devices.authenticate(&success.device_id, &success.token, original_epoch + 1),
        Err(DeviceStoreError::AuthenticationFailed)
    );
    assert_eq!(
        devices.validate_principal(&principal),
        Err(DeviceStoreError::IdentityEpochMismatch)
    );
}

#[test]
fn coordinated_identity_rotation_invalidates_credentials_and_connections() {
    let store = InMemoryIdentityStore::default();
    create_initial_identity(&store, "desktop-1", vec!["localhost".to_owned()])
        .expect("create identity");
    let devices = Arc::new(DeviceRegistry::new());
    let manager = PairingManager::new(Arc::clone(&devices));
    let payload = issue(&manager, 1_000);
    let success = manager
        .redeem(
            PairingRequest {
                version: 1,
                pairing_id: payload.pairing_id,
                secret: payload.secret,
                device: device_metadata(),
            },
            1_001,
        )
        .expect("pair device");
    let old_epoch = devices.identity_epoch().expect("old identity epoch");
    let principal = devices
        .authenticate(&success.device_id, &success.token, old_epoch)
        .expect("authenticate old device");
    devices
        .open_connection(&principal, "rotation-connection")
        .expect("open old connection");

    let (rotated, closed) = manager
        .rotate_identity(&store, "desktop-1", vec!["localhost".to_owned()])
        .expect("rotate identity");
    assert_eq!(rotated.identity_epoch(), old_epoch + 1);
    assert_eq!(closed, vec!["rotation-connection".to_owned()]);
    assert_eq!(
        load_identity(&store)
            .expect("load rotated identity")
            .certificate_pin(),
        rotated.certificate_pin()
    );
    assert_eq!(
        devices.authenticate(&success.device_id, &success.token, old_epoch),
        Err(DeviceStoreError::IdentityEpochMismatch)
    );
    assert_eq!(
        devices.authenticate(&success.device_id, &success.token, old_epoch + 1),
        Err(DeviceStoreError::AuthenticationFailed)
    );
}

#[test]
fn device_registry_enforces_capacity_constant_time_auth_and_connection_limits() {
    let devices = DeviceRegistry::new();
    let mut registered = Vec::new();
    for index in 0..MAX_PAIRED_DEVICES {
        let mut metadata = device_metadata();
        metadata.device_id = format!("client-{index}");
        registered.push(
            devices
                .register(metadata, index as u64)
                .expect("register device"),
        );
    }
    let mut metadata = device_metadata();
    metadata.device_id = "client-overflow".to_owned();
    assert_eq!(
        devices.register(metadata, 99),
        Err(DeviceStoreError::Capacity)
    );
    let first = &registered[0];
    assert_eq!(
        devices.authenticate(&first.device_id, "wrong-token", first.identity_epoch),
        Err(DeviceStoreError::AuthenticationFailed)
    );
    let principal = devices
        .authenticate(&first.device_id, &first.token, first.identity_epoch)
        .expect("authenticate");
    for index in 0..MAX_CONNECTIONS_PER_DEVICE {
        devices
            .open_connection(&principal, &format!("connection-{index}"))
            .expect("open connection");
    }
    assert_eq!(
        devices.open_connection(&principal, "connection-overflow"),
        Err(DeviceStoreError::ConnectionLimit)
    );
    let revoked = devices.revoke(&first.device_id).expect("revoke device");
    assert_eq!(
        revoked.closed_connection_ids.len(),
        MAX_CONNECTIONS_PER_DEVICE
    );
    assert_eq!(
        devices.list_devices().expect("list devices").len(),
        MAX_PAIRED_DEVICES - 1
    );
    assert!(MAX_AUTHENTICATED_CONNECTIONS >= MAX_CONNECTIONS_PER_DEVICE);
}

#[test]
fn invalid_pairing_ticket_errors_are_non_oracular() {
    let devices = Arc::new(DeviceRegistry::new());
    let manager = PairingManager::new(devices);
    let payload = issue(&manager, 1_000);
    let mut wrong = PairingRequest {
        version: 1,
        pairing_id: payload.pairing_id.clone(),
        secret: "00".repeat(32),
        device: device_metadata(),
    };
    let wrong_result = manager
        .redeem_response(wrong.clone(), 1_001)
        .expect_err("wrong secret");
    assert_eq!(wrong_result.error, PairingFailureCode::InvalidTicket);
    wrong.secret = payload.secret;
    manager
        .redeem_response(wrong, 1_002)
        .expect("a single invalid guess does not consume the ticket");
    let replay_result = manager
        .redeem_response(
            PairingRequest {
                version: 1,
                pairing_id: payload.pairing_id,
                secret: "00".repeat(32),
                device: device_metadata(),
            },
            1_003,
        )
        .expect_err("consumed ticket");
    assert_eq!(replay_result.error, PairingFailureCode::InvalidTicket);
}

#[test]
fn pairing_expiry_is_inclusive_and_capacity_failure_does_not_consume_ticket() {
    let devices = Arc::new(DeviceRegistry::new());
    let manager = PairingManager::new(Arc::clone(&devices));
    let expired = issue(&manager, 1_000);
    let expired_request = PairingRequest {
        version: 1,
        pairing_id: expired.pairing_id,
        secret: expired.secret,
        device: device_metadata(),
    };
    assert_eq!(
        manager
            .redeem_response(expired_request, 121_000)
            .unwrap_err()
            .error,
        PairingFailureCode::InvalidTicket
    );
    assert_eq!(manager.ticket_count().expect("ticket count"), 0);

    for index in 0..MAX_PAIRED_DEVICES {
        let mut metadata = device_metadata();
        metadata.device_id = format!("capacity-client-{index}");
        devices
            .register(metadata, index as u64)
            .expect("fill device capacity");
    }
    let available = issue(&manager, 2_000);
    let available_request = PairingRequest {
        version: 1,
        pairing_id: available.pairing_id,
        secret: available.secret,
        device: device_metadata(),
    };
    assert_eq!(
        manager
            .redeem_response(available_request, 2_001)
            .unwrap_err()
            .error,
        PairingFailureCode::RateLimited
    );
    assert_eq!(
        manager.ticket_count().expect("ticket retained for retry"),
        1
    );
}

#[test]
fn config_rejects_duplicate_and_overselected_addresses() {
    let address = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
    assert_eq!(
        validate_selected_addresses(&[address, address]),
        Err(BindPolicyError::DuplicateAddress)
    );
    let addresses = (1..=9)
        .map(|host| IpAddr::V4(Ipv4Addr::new(192, 168, 1, host)))
        .collect::<Vec<_>>();
    assert_eq!(
        validate_selected_addresses(&addresses),
        Err(BindPolicyError::TooManyAddresses)
    );
}

#[test]
fn expired_tickets_are_pruned_before_capacity_is_rejected() {
    let devices = Arc::new(DeviceRegistry::new());
    let manager = PairingManager::new(devices);
    for _ in 0..64 {
        issue(&manager, 1_000);
    }
    assert_eq!(manager.ticket_count().expect("ticket count"), 64);
    issue(&manager, 121_000);
    assert_eq!(manager.ticket_count().expect("expired tickets pruned"), 1);
}

#[test]
fn credential_bearing_debug_output_is_redacted() {
    let devices = Arc::new(DeviceRegistry::new());
    let manager = PairingManager::new(Arc::clone(&devices));
    let payload = issue(&manager, 1_000);
    let payload_debug = format!("{payload:?}");
    assert!(!payload_debug.contains(&payload.secret));
    assert!(payload_debug.contains("<redacted>"));

    let request = PairingRequest {
        version: 1,
        pairing_id: payload.pairing_id.clone(),
        secret: payload.secret.clone(),
        device: device_metadata(),
    };
    let request_debug = format!("{request:?}");
    assert!(!request_debug.contains(&payload.secret));

    let success = PairingSuccess {
        version: 1,
        device_id: "device-opaque".to_owned(),
        token: "token-secret".to_owned(),
        server_time: "2026-01-01T00:00:00.000Z".to_owned(),
    };
    let success_debug = format!("{success:?}");
    assert!(!success_debug.contains(&success.token));
}

#[test]
fn identity_rejects_certificate_private_key_mismatch() {
    let store = InMemoryIdentityStore::default();
    let identity = create_initial_identity(&store, "desktop-1", vec!["localhost".to_owned()])
        .expect("create identity");
    let mut stored = identity.stored();
    let key_pair = KeyPair::from_pkcs8_der_and_sign_algo(
        &PrivatePkcs8KeyDer::from(stored.private_key_der.as_slice()),
        &rcgen::PKCS_ECDSA_P256_SHA256,
    )
    .expect("decode private key");
    let spki = key_pair.public_key_der();
    let spki_offset = stored
        .certificate_der
        .windows(spki.len())
        .position(|window| window == spki)
        .expect("certificate contains matching SPKI");
    stored.certificate_der[spki_offset + spki.len() / 2] ^= 1;
    assert!(matches!(
        CertificateIdentity::from_stored(stored),
        Err(IdentityError::CorruptMaterial | IdentityError::FingerprintMismatch)
    ));
}

#[test]
fn revoking_one_device_does_not_affect_another_device() {
    let devices = DeviceRegistry::new();
    let first = devices
        .register(
            PairingDeviceMetadata {
                device_id: "first-client".to_owned(),
                ..device_metadata()
            },
            1,
        )
        .expect("register first device");
    let second = devices
        .register(
            PairingDeviceMetadata {
                device_id: "second-client".to_owned(),
                ..device_metadata()
            },
            2,
        )
        .expect("register second device");
    let first_principal = devices
        .authenticate(&first.device_id, &first.token, first.identity_epoch)
        .expect("authenticate first device");
    let second_principal = devices
        .authenticate(&second.device_id, &second.token, second.identity_epoch)
        .expect("authenticate second device");
    devices
        .open_connection(&first_principal, "first-connection")
        .expect("open first connection");
    devices
        .open_connection(&second_principal, "second-connection")
        .expect("open second connection");
    devices
        .validate_principal(&second_principal)
        .expect("second principal is live before revoke");

    let revoked = devices
        .revoke(&second.device_id)
        .expect("revoke second device");
    assert_eq!(
        revoked.closed_connection_ids,
        vec!["second-connection".to_owned()]
    );
    assert!(devices
        .authenticate(&first.device_id, &first.token, first.identity_epoch)
        .is_ok());
    assert_eq!(
        devices.authenticate(&second.device_id, &second.token, second.identity_epoch),
        Err(DeviceStoreError::AuthenticationFailed)
    );
    assert_eq!(
        devices.validate_principal(&second_principal),
        Err(DeviceStoreError::AuthenticationFailed)
    );
}
