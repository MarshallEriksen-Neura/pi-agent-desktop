use pi_remote_control::device_store::DeviceRegistry;
use pi_remote_control::principal::RemoteScope;
use pi_remote_control::protocol::PairingDeviceMetadata;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn model_admin_grant_mints_scope_and_revocation_removes_it() {
    let registry = DeviceRegistry::new();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let registered = registry
        .register(
            PairingDeviceMetadata {
                device_id: "mobile-01".into(),
                display_name: "phone".into(),
                platform: pi_remote_control::protocol::PairingDevicePlatform::Ios,
                app_version: None,
            },
            now,
        )
        .unwrap();

    let epoch = registry.identity_epoch().unwrap();
    let device_id = registered.device_id.clone();
    let plain = registry
        .authenticate(&device_id, &registered.token, epoch)
        .unwrap();
    assert!(!plain.has_scope(RemoteScope::ModelAdmin));
    assert!(plain.has_scope(RemoteScope::CreateTasks));

    registry.set_model_admin(&device_id, true).unwrap();
    let granted = registry
        .authenticate(&device_id, &registered.token, epoch)
        .unwrap();
    assert!(granted.has_scope(RemoteScope::ModelAdmin));

    registry.set_model_admin(&device_id, false).unwrap();
    let revoked = registry
        .authenticate(&device_id, &registered.token, epoch)
        .unwrap();
    assert!(!revoked.has_scope(RemoteScope::ModelAdmin));
}
