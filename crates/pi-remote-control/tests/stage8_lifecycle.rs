use pi_remote_control::config::{validate_selected_addresses, RemoteControlConfig};
use pi_remote_control::device_store::DeviceRegistry;
use pi_remote_control::gateway::{build_router, build_server_config, GatewayServer, GatewayState};
use pi_remote_control::identity::{create_initial_identity, InMemoryIdentityStore};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls::{ClientConfig, RootCertStore};
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::Arc;
use tokio_rustls::TlsConnector;

fn local_private_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    validate_selected_addresses(&[address]).ok()?;
    Some(address)
}

#[tokio::test]
async fn enabled_private_interface_listener_starts_with_tls_and_shuts_down() {
    let Some(address) = local_private_address() else {
        // CI runners without a private interface cannot prove the bind path;
        // the policy test remains authoritative for those environments.
        return;
    };
    let probe = tokio::net::TcpListener::bind(SocketAddr::new(address, 0))
        .await
        .expect("private interface probe");
    let port = probe.local_addr().expect("probe address").port();
    drop(probe);
    let identity_store = InMemoryIdentityStore::default();
    let identity = create_initial_identity(
        &identity_store,
        "stage8-desktop",
        vec!["localhost".to_owned()],
    )
    .expect("identity");
    let state = GatewayState::new(identity.clone(), Arc::new(DeviceRegistry::new()), "stage8");
    let config = RemoteControlConfig::try_new(true, vec![address], port).expect("bind policy");
    let tls = build_server_config(&identity).expect("tls config");
    let server = GatewayServer::start(&config, build_router(state.clone()), tls)
        .await
        .expect("enabled gateway start");

    // Prove the certificate presented by the real listener is the same
    // identity whose SPKI pin is emitted through GatewayState/QR composition.
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(identity.certificate_der().to_vec()))
        .expect("trust generated test certificate");
    let client = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(client));
    let stream = tokio::net::TcpStream::connect(SocketAddr::new(address, port))
        .await
        .expect("connect to gateway TLS listener");
    let server_name = ServerName::try_from("localhost")
        .expect("valid test server name")
        .to_owned();
    let tls_stream = connector
        .connect(server_name, stream)
        .await
        .expect("complete gateway TLS handshake");
    let peer_certificates = tls_stream
        .get_ref()
        .1
        .peer_certificates()
        .expect("gateway presents a certificate");
    assert_eq!(peer_certificates.len(), 1);
    assert_eq!(peer_certificates[0].as_ref(), identity.certificate_der());
    assert_eq!(state.identity.certificate_pin(), identity.certificate_pin());
    drop(tls_stream);

    server.shutdown().await.expect("enabled gateway shutdown");
    state.supervisor.stop();
    assert_eq!(state.supervisor.active_len(), 0);
}
